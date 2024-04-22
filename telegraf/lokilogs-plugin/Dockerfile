# Stage 1: Build Telegraf with new Plugin
FROM golang:1.22 AS builder

# Clone telegraf source code
RUN git clone https://github.com/influxdata/telegraf.git /telegraf
WORKDIR /telegraf

# copy telegraf plugin code into image 
COPY /plugins/outputs/lokilogs/lokilogs.go /telegraf/plugins/outputs/lokilogs/lokilogs.go
COPY /plugins/outputs/lokilogs/stream.go /telegraf/plugins/outputs/lokilogs/stream.go
COPY /plugins/outputs/lokilogs/sample.conf /telegraf/plugins/outputs/lokilogs/sample.conf 
COPY /plugins/outputs/lokilogs/README.md /telegraf/plugins/outputs/lokilogs/README.md
COPY /plugins/outputs/lokilogs/all/lokilogs.go /telegraf/plugins/outputs/all/lokilogs.go

# Build Telegram Binary with new custom plugin
RUN make

# Stage 2: Create final Telegram Image
# --> For smaller Image Size.
FROM telegraf:alpine

# Replace old Telegraf Binary without custom Plugin.
COPY --from=builder /telegraf/telegraf /usr/bin/telegraf

# Set Workdir
WORKDIR /etc/telegraf

# Start Telegraf
CMD ["telegraf"]
