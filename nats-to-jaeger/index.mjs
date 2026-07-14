const scalarResourcePrefixes = [
  "service.",
  "host.",
  "os.",
  "process.",
  "container.",
  "k8s.",
  "cloud.",
  "deployment.",
  "faas.",
  "telemetry.sdk.",
];

const pendingSpans = new Map();
const flushDelayMs = parseInteger(process.env.FLUSH_DELAY_MS, 1000);

function parseInteger(value, fallback) {
  const parsed = Number.parseInt(value ?? "", 10);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function normalizeNatsServer(server) {
  if (!server) {
    throw new Error("NATS environment variable is required");
  }
  if (server.startsWith("nats://") || server.startsWith("tls://")) {
    return server;
  }
  return `nats://${server}`;
}

function readRequiredEnv(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(`${name} environment variable is required`);
  }
  return value;
}

function safeJsonParse(text, fallback) {
  try {
    return JSON.parse(text);
  } catch (error) {
    console.warn(`Failed to parse JSON: ${error.message}`);
    return fallback;
  }
}

function parseUnsignedBigInt(value) {
  if (value === undefined || value === null || value === "") {
    return undefined;
  }
  if (typeof value === "bigint") {
    return value;
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value) || value < 0) {
      return undefined;
    }
    return BigInt(Math.trunc(value));
  }
  if (typeof value === "string") {
    if (!/^\d+$/.test(value)) {
      return undefined;
    }
    return BigInt(value);
  }
  return undefined;
}

function normalizeHexIdentifier(hex, byteLength) {
  if (typeof hex !== "string" || !/^[0-9a-fA-F]+$/.test(hex)) {
    throw new Error(`invalid hex value: ${hex}`);
  }
  if (hex.length !== byteLength * 2) {
    throw new Error(`expected ${byteLength * 2} hex chars, got ${hex.length}`);
  }
  return hex.toLowerCase();
}

function spanKindToOtlp(kind) {
  if (!kind) {
    return 0;
  }

  const normalized = String(kind).trim().toUpperCase();
  switch (normalized) {
    case "SPAN_KIND_INTERNAL":
    case "INTERNAL":
      return 1;
    case "SPAN_KIND_SERVER":
    case "SERVER":
      return 2;
    case "SPAN_KIND_CLIENT":
    case "CLIENT":
      return 3;
    case "SPAN_KIND_PRODUCER":
    case "PRODUCER":
      return 4;
    case "SPAN_KIND_CONSUMER":
    case "CONSUMER":
      return 5;
    default:
      return 0;
  }
}

function statusCodeToOtlp(statusCode) {
  if (!statusCode) {
    return undefined;
  }

  const normalized = String(statusCode).trim().toUpperCase();
  switch (normalized) {
    case "STATUS_CODE_OK":
    case "OK":
      return 1;
    case "STATUS_CODE_ERROR":
    case "ERROR":
      return 2;
    case "STATUS_CODE_UNSET":
    case "UNSET":
      return 0;
    default:
      return undefined;
  }
}

function scalarToAnyValue(value) {
  if (value === null) {
    return { stringValue: "null" };
  }
  if (Array.isArray(value)) {
    return { arrayValue: { values: value.map(scalarToAnyValue) } };
  }
  if (typeof value === "boolean") {
    return { boolValue: value };
  }
  if (typeof value === "string") {
    return { stringValue: value };
  }
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return { intValue: String(value) };
    }
    return { doubleValue: value };
  }
  if (typeof value === "bigint") {
    return { intValue: value.toString() };
  }
  if (typeof value === "object") {
    return {
      kvlistValue: {
        values: Object.entries(value).map(([key, nestedValue]) => ({
          key,
          value: scalarToAnyValue(nestedValue),
        })),
      },
    };
  }
  return { stringValue: String(value) };
}

function attributesToOtlp(attributes) {
  return Object.entries(attributes).map(([key, value]) => ({
    key,
    value: scalarToAnyValue(value),
  }));
}

function parseMetric(message) {
  const metric = safeJsonParse(preserveIntegerPrecision(message), null);
  if (!metric || typeof metric !== "object") {
    return null;
  }
  return {
    name: metric.name,
    tags: metric.tags ?? {},
    fields: metric.fields ?? {},
    timestamp: metric.timestamp,
  };
}

function preserveIntegerPrecision(message) {
  return message
    .replace(/("timestamp"\s*:\s*)(\d+)/g, '$1"$2"')
    .replace(/("end_time_unix_nano"\s*:\s*)(\d+)/g, '$1"$2"')
    .replace(/("duration_nano"\s*:\s*)(\d+)/g, '$1"$2"');
}

function parseAttributesField(fields) {
  const raw = fields.attributes;
  if (typeof raw === "string") {
    const parsed = safeJsonParse(raw, null);
    return parsed && typeof parsed === "object" ? parsed : {};
  }
  if (raw && typeof raw === "object") {
    return raw;
  }
  return {};
}

function splitResourceAndSpanAttributes(metric) {
  const parsedAttributes = parseAttributesField(metric.fields);
  const resourceAttributes = {};
  const spanAttributes = { ...parsedAttributes };

  if (metric.tags["service.name"]) {
    resourceAttributes["service.name"] = metric.tags["service.name"];
  }
  if (
    !resourceAttributes["host.name"] &&
    typeof parsedAttributes["host.name"] === "string"
  ) {
    resourceAttributes["host.name"] = parsedAttributes["host.name"];
    delete spanAttributes["host.name"];
  } else if (
    !resourceAttributes["host.name"] &&
    typeof metric.tags.host === "string"
  ) {
    resourceAttributes["host.name"] = metric.tags.host;
  }

  for (const [key, value] of Object.entries(parsedAttributes)) {
    if (scalarResourcePrefixes.some((prefix) => key.startsWith(prefix))) {
      resourceAttributes[key] = value;
      delete spanAttributes[key];
    }
  }

  return { resourceAttributes, spanAttributes };
}

function buildSpanRecord(metric) {
  if (metric.name !== "spans") {
    return null;
  }

  const traceId = metric.tags.trace_id;
  const spanId = metric.tags.span_id;
  if (!traceId || !spanId) {
    throw new Error("span metric is missing trace_id or span_id tag");
  }

  const { resourceAttributes, spanAttributes } =
    splitResourceAndSpanAttributes(metric);
  const fields = metric.fields;
  const endTimeUnixNano = parseUnsignedBigInt(fields.end_time_unix_nano);
  const durationNano = parseUnsignedBigInt(fields.duration_nano);
  let startTimeUnixNano;

  if (
    endTimeUnixNano !== undefined &&
    durationNano !== undefined &&
    endTimeUnixNano >= durationNano
  ) {
    startTimeUnixNano = endTimeUnixNano - durationNano;
  } else {
    const timestampSeconds = parseUnsignedBigInt(metric.timestamp);
    if (timestampSeconds === undefined) {
      throw new Error(
        "span metric is missing timestamp and cannot derive start time",
      );
    }
    startTimeUnixNano = timestampSeconds * 1000000000n;
  }

  const scope = {};
  if (
    fields.instrumentation_scope_name ||
    fields.instrumentation_library_name
  ) {
    scope.name = String(
      fields.instrumentation_scope_name ?? fields.instrumentation_library_name,
    );
  }
  if (
    fields.instrumentation_scope_version ||
    fields.instrumentation_library_version
  ) {
    scope.version = String(
      fields.instrumentation_scope_version ??
        fields.instrumentation_library_version,
    );
  }

  const span = {
    traceId: normalizeHexIdentifier(traceId, 16),
    spanId: normalizeHexIdentifier(spanId, 8),
    name: String(fields["span.name"] ?? fields.name ?? "unnamed-span"),
    kind: spanKindToOtlp(fields["span.kind"] ?? fields.kind),
    startTimeUnixNano: startTimeUnixNano.toString(),
    attributes: attributesToOtlp(spanAttributes),
    events: [],
    links: [],
  };

  if (metric.fields.parent_span_id) {
    span.parentSpanId = normalizeHexIdentifier(
      String(metric.fields.parent_span_id),
      8,
    );
  }
  if (endTimeUnixNano !== undefined) {
    span.endTimeUnixNano = endTimeUnixNano.toString();
  }
  if (fields.trace_state) {
    span.traceState = String(fields.trace_state);
  }

  const statusCode = statusCodeToOtlp(
    fields["otel.status_code"] ?? fields.status_code,
  );
  const statusMessage =
    fields["otel.status_description"] ?? fields.status_description;
  if (statusCode !== undefined || statusMessage) {
    span.status = {};
    if (statusCode !== undefined) {
      span.status.code = statusCode;
    }
    if (statusMessage) {
      span.status.message = String(statusMessage);
    }
  }

  return {
    key: `${traceId}:${spanId}`,
    traceId,
    spanId,
    resourceAttributes,
    scope,
    span,
  };
}

function buildSpanEvent(metric) {
  if (metric.name !== "logs" || !metric.tags.trace_id || !metric.tags.span_id) {
    return null;
  }

  const attributes = parseAttributesField(metric.fields);
  const event = {
    timeUnixNano: (
      (parseUnsignedBigInt(metric.timestamp) ?? 0n) * 1000000000n
    ).toString(),
    name: String(metric.fields["event.name"] ?? metric.fields.name ?? "event"),
    attributes: attributesToOtlp(attributes),
  };

  return {
    key: `${metric.tags.trace_id}:${metric.tags.span_id}`,
    event,
  };
}

function buildSpanLink(metric) {
  if (
    !["span-links", "span_links"].includes(metric.name) ||
    !metric.tags.trace_id ||
    !metric.tags.span_id
  ) {
    return null;
  }

  const linkedTraceId = metric.tags.linked_trace_id;
  const linkedSpanId = metric.tags.linked_span_id;
  if (!linkedTraceId || !linkedSpanId) {
    return null;
  }

  const attributes = parseAttributesField(metric.fields);
  const link = {
    traceId: normalizeHexIdentifier(String(linkedTraceId), 16),
    spanId: normalizeHexIdentifier(String(linkedSpanId), 8),
    attributes: attributesToOtlp(attributes),
  };
  if (metric.fields.trace_state) {
    link.traceState = String(metric.fields.trace_state);
  }

  return {
    key: `${metric.tags.trace_id}:${metric.tags.span_id}`,
    link,
  };
}

function ensurePendingSpan(key) {
  const existing = pendingSpans.get(key);
  if (existing) {
    return existing;
  }

  const created = {
    record: null,
    events: [],
    links: [],
    timer: null,
  };
  pendingSpans.set(key, created);
  return created;
}

function scheduleFlush(key) {
  const pending = pendingSpans.get(key);
  if (!pending) {
    return;
  }
  if (pending.timer) {
    clearTimeout(pending.timer);
  }
  pending.timer = setTimeout(async () => {
    const current = pendingSpans.get(key);
    if (!current) {
      return;
    }
    pendingSpans.delete(key);
    if (!current.record) {
      console.warn(`Dropping orphaned supplemental trace data for ${key}`);
      return;
    }
    current.record.span.events.push(...current.events);
    current.record.span.links.push(...current.links);
    const payload = recordToOtlpPayload(current.record);
    try {
      await postToJaeger(payload);
      console.log(
        `Forwarded span ${current.record.spanId} of trace ${current.record.traceId}`,
      );
    } catch (error) {
      console.error(
        `Failed to forward span ${current.record.spanId}: ${error.message}`,
      );
    }
  }, flushDelayMs);
}

function recordToOtlpPayload(record) {
  const scopeSpans = {
    spans: [record.span],
  };
  if (Object.keys(record.scope).length > 0) {
    scopeSpans.scope = record.scope;
  }

  return {
    resourceSpans: [
      {
        resource: {
          attributes: attributesToOtlp(record.resourceAttributes),
        },
        scopeSpans: [scopeSpans],
      },
    ],
  };
}

async function postToJaeger(payload) {
  const endpoint = readRequiredEnv("JAEGER_OTLP_HTTP_ENDPOINT");
  const response = await fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Jaeger returned ${response.status}: ${body}`);
  }
}

async function processMetricJson(message) {
  const metric = parseMetric(message);
  if (!metric) {
    return;
  }

  const spanRecord = buildSpanRecord(metric);
  if (spanRecord) {
    const pending = ensurePendingSpan(spanRecord.key);
    pending.record = spanRecord;
    scheduleFlush(spanRecord.key);
    return;
  }

  const spanEvent = buildSpanEvent(metric);
  if (spanEvent) {
    const pending = ensurePendingSpan(spanEvent.key);
    pending.events.push(spanEvent.event);
    scheduleFlush(spanEvent.key);
    return;
  }

  const spanLink = buildSpanLink(metric);
  if (spanLink) {
    const pending = ensurePendingSpan(spanLink.key);
    pending.links.push(spanLink.link);
    scheduleFlush(spanLink.key);
    return;
  }

  console.warn(`Ignoring unsupported metric ${metric.name ?? "unknown"}`);
}

async function runConversionFromStdin() {
  let text = "";
  for await (const chunk of process.stdin) {
    text += chunk;
  }
  const metric = parseMetric(text);
  if (!metric) {
    throw new Error("stdin did not contain a valid Telegraf JSON metric");
  }
  const spanRecord = buildSpanRecord(metric);
  if (!spanRecord) {
    throw new Error(
      `stdin metric ${metric.name ?? "unknown"} is not a spans metric`,
    );
  }
  process.stdout.write(
    `${JSON.stringify(recordToOtlpPayload(spanRecord), null, 2)}\n`,
  );
}

async function runSubscriber() {
  const { connect, StringCodec } = await import("nats");
  const sc = StringCodec();
  const subject = `sponsor.${readRequiredEnv("SPONSORID")}.sfh.${readRequiredEnv("SFHID")}.provider.${readRequiredEnv("PROVIDERID")}.app.${readRequiredEnv("APPID")}.otlp`;
  const nc = await connect({
    servers: normalizeNatsServer(readRequiredEnv("NATS")),
    user: "openid",
    pass: readRequiredEnv("TOKEN"),
  });

  console.log(`Subscribed to ${subject} on ${nc.getServer()}`);
  const subscription = nc.subscribe(subject);
  for await (const message of subscription) {
    try {
      await processMetricJson(sc.decode(message.data));
    } catch (error) {
      console.error(`Failed to process message: ${error.message}`);
    }
  }
}

try {
  if (process.env.STDIN_TO_OTLP === "1") {
    await runConversionFromStdin();
  } else {
    await runSubscriber();
  }
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
