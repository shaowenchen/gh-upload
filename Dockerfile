FROM hubimage/builder-golang:1.19 AS builder
COPY . .
RUN make build

FROM hubimage/runtime-ubuntu:22.04
COPY --from=builder /builder/bin/app .
COPY --from=builder /builder/default.toml .
CMD [ "./app", "-c", "./default.toml"]
EXPOSE 80
