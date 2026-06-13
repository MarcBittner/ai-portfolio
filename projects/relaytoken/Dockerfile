# Multi-stage: build a static Go binary, ship it on distroless as non-root.
FROM golang:1.26 AS build
WORKDIR /src
# Cache modules first.
COPY go.mod go.sum ./
RUN go mod download
COPY . .
# Static, stripped binary so it runs on a scratch/distroless base.
RUN CGO_ENABLED=0 GOOS=linux go build -trimpath -ldflags="-s -w" \
    -o /out/relaytoken ./cmd/relaytoken

# Minimal, non-root runtime.
FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/relaytoken /relaytoken
ENV PORT=8080
EXPOSE 8080
USER nonroot:nonroot
# Distroless has no shell; the binary self-serves /healthz on $PORT.
HEALTHCHECK --interval=30s --timeout=3s --retries=3 \
    CMD ["/relaytoken", "healthcheck"]
ENTRYPOINT ["/relaytoken"]
