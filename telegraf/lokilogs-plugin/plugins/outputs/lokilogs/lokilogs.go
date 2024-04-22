//go:generate ../../../tools/readme_config_includer/generator
package lokilogs

import (
	"bytes"
	"context"
	_ "embed"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"time"

	"golang.org/x/oauth2"
	"golang.org/x/oauth2/clientcredentials"

	"github.com/influxdata/telegraf"
	"github.com/influxdata/telegraf/config"
	"github.com/influxdata/telegraf/plugins/common/tls"
	"github.com/influxdata/telegraf/plugins/outputs"
)

//go:embed sample.conf
var sampleConfig string

const (
	defaultEndpoint      = "/loki/api/v1/push"
	defaultClientTimeout = 5 * time.Second
)

type Loki struct {
	Domain          string            `toml:"domain"`
	Endpoint        string            `toml:"endpoint"`
	Timeout         config.Duration   `toml:"timeout"`
	Username        config.Secret     `toml:"username"`
	Password        config.Secret     `toml:"password"`
	Headers         map[string]string `toml:"http_headers"`
	ClientID        string            `toml:"client_id"`
	ClientSecret    string            `toml:"client_secret"`
	TokenURL        string            `toml:"token_url"`
	Scopes          []string          `toml:"scopes"`
	GZipRequest     bool              `toml:"gzip_request"`
	MetricNameLabel string            `toml:"metric_name_label"`

	url    string
	client *http.Client
	tls.ClientConfig
}

func (l *Loki) createClient(ctx context.Context) (*http.Client, error) {
	tlsCfg, err := l.ClientConfig.TLSConfig()
	if err != nil {
		return nil, fmt.Errorf("tls config fail: %w", err)
	}

	client := &http.Client{
		Transport: &http.Transport{
			TLSClientConfig: tlsCfg,
			Proxy:           http.ProxyFromEnvironment,
		},
		Timeout: time.Duration(l.Timeout),
	}

	if l.ClientID != "" && l.ClientSecret != "" && l.TokenURL != "" {
		oauthConfig := clientcredentials.Config{
			ClientID:     l.ClientID,
			ClientSecret: l.ClientSecret,
			TokenURL:     l.TokenURL,
			Scopes:       l.Scopes,
		}
		ctx = context.WithValue(ctx, oauth2.HTTPClient, client)
		client = oauthConfig.Client(ctx)
	}

	return client, nil
}

func (*Loki) SampleConfig() string {
	return sampleConfig
}

func (l *Loki) Connect() (err error) {
	if l.Domain == "" {
		return errors.New("domain is required")
	}

	if l.Endpoint == "" {
		l.Endpoint = defaultEndpoint
	}

	l.url = fmt.Sprintf("%s%s", l.Domain, l.Endpoint)

	if l.Timeout == 0 {
		l.Timeout = config.Duration(defaultClientTimeout)
	}

	ctx := context.Background()
	l.client, err = l.createClient(ctx)
	if err != nil {
		return fmt.Errorf("http client fail: %w", err)
	}

	return nil
}

func (l *Loki) Close() error {
	l.client.CloseIdleConnections()

	return nil
}

// takes a metric and and changes the labels to match the label restrictions of loki. Returns tags
func (l *Loki) formatAndInitiliazeMetric(m telegraf.Metric) []*telegraf.Tag {
	// Creates a Slice of which its elements are from type Pointers of telegraf.Tag, and has a length of tags in this metric
	tags := make([]*telegraf.Tag, len(m.TagList()))
	// Iterates through the tags of the metric
	for i, t := range m.TagList() {
		// takes key and value of the metric and replaces "-" with "_"
		key := strings.ReplaceAll(t.Key, "-", "_")
		value := strings.ReplaceAll(t.Value, "-", "_")
		// creates a new type of telegraf.Tag with key and value of the metric and saves it as the pointer of the tag
		tags[i] = &telegraf.Tag{Key: key, Value: value}
	}

	return tags
}

// Takes a string (logline) and utilizes a regex to identify Key="Value" structures and returns a map of them.
func (l *Loki) parseKeyValuePairs(line string) (map[string]string, error) {
	result := make(map[string]string)

	// Regex adapted for key-value pairs separated by spaces
	pairRegex := regexp.MustCompile(`(\w+)="([^"]*)"`)
	matches := pairRegex.FindAllStringSubmatch(line, -1)

	for _, match := range matches {
		key := match[1]
		value := match[2]
		result[key] = value
	}

	return result, nil
}

func (l *Loki) Write(metrics []telegraf.Metric) error {
	s := Streams{}

	// sort metrics by time --> m.Time()
	sort.SliceStable(metrics, func(i, j int) bool {
		return metrics[i].Time().Before(metrics[j].Time())
	})

	// Iterates through metrics streams
	for _, m := range metrics {

		// Sets the tag on the metric if its empty
		if l.MetricNameLabel != "" {
			m.AddTag(l.MetricNameLabel, strings.ReplaceAll(m.Name(), "-", "_"))
		}

		// Initliaze tags and line objects which are formatted in correct loki label restrictions
		tags := l.formatAndInitiliazeMetric(m)

		// Creates a variable of type string
		var line string

		// Iterates through the fields of the metric
		for _, f := range m.FieldList() {
			// Creates a metric in the style key="value" and adds it to line
			line += fmt.Sprintf("%s=\"%v\" ", f.Key, f.Value)
		}

		// Parse logline and create map object
		logMap, logMapParseErr := l.parseKeyValuePairs(line)
		if logMapParseErr != nil {
			fmt.Println(logMapParseErr)
		}

		// Add channel as label to tags
		if channel, ok := logMap["channel"]; ok {
			channelTag := &telegraf.Tag{Key: "channel", Value: channel}
			tags = append(tags, channelTag)
		}

		// Create logline from log_message
		var logline string
		if logMessage, ok := logMap["log_message"]; ok {
			logline = logMessage
		} else {
			logline = line
		}

		// Initialize a timestamp in nanoseconds for logs without the time of the log.
		timestamp := strconv.FormatInt(m.Time().UnixNano(), 10)

		//Set Timestamp to timestamp from log
		if timestampFromLog, ok := logMap["time"]; ok {
			if parsedTime, parseErr := time.Parse(time.RFC3339Nano, timestampFromLog); parseErr == nil {
				timestamp = strconv.FormatInt(parsedTime.UnixNano(), 10)
			}
		}

		s.insertLog(tags, Log{timestamp, logline})

	}

	return l.writeMetrics(s)
}

func (l *Loki) writeMetrics(s Streams) error {
	bs, err := json.Marshal(s)
	if err != nil {
		return fmt.Errorf("json.Marshal: %w", err)
	}

	var reqBodyBuffer io.Reader = bytes.NewBuffer(bs)

	req, err := http.NewRequest(http.MethodPost, l.url, reqBodyBuffer)
	if err != nil {
		return err
	}

	if !l.Username.Empty() {
		username, err := l.Username.Get()
		if err != nil {
			return fmt.Errorf("getting username failed: %w", err)
		}
		password, err := l.Password.Get()
		if err != nil {
			username.Destroy()
			return fmt.Errorf("getting password failed: %w", err)
		}
		req.SetBasicAuth(username.String(), password.String())
		username.Destroy()
		password.Destroy()
	}

	for k, v := range l.Headers {
		if strings.EqualFold(k, "host") {
			req.Host = v
		}
		req.Header.Set(k, v)
	}

	req.Header.Set("Content-Type", "application/json")
	if l.GZipRequest {
		req.Header.Set("Content-Encoding", "gzip")
	}

	resp, err := l.client.Do(req)
	if err != nil {
		return err
	}
	defer resp.Body.Close()

	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		body, _ := io.ReadAll(resp.Body)
		return fmt.Errorf("when writing to [%s] received status code, %d: %s", l.url, resp.StatusCode, body)
	}

	return nil
}

func init() {
	outputs.Add("lokilogs", func() telegraf.Output {
		return &Loki{
			MetricNameLabel: "__name",
		}
	})
}
