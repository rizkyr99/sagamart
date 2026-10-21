# Build context is the repository root (the service imports the generated contracts module):
#   docker build -f services/inventory/Dockerfile .
FROM golang:1.27.3 AS build
WORKDIR /src

COPY contracts/gen/go/go.mod contracts/gen/go/go.sum contracts/gen/go/
COPY services/inventory/go.mod services/inventory/go.sum services/inventory/
RUN cd services/inventory && go mod download

COPY contracts/gen/go contracts/gen/go
COPY services/inventory services/inventory
ARG VERSION=dev
RUN cd services/inventory && \
    CGO_ENABLED=0 go build -trimpath -ldflags "-s -w -X main.version=${VERSION}" -o /out/inventory ./cmd/inventory

FROM gcr.io/distroless/static-debian12:nonroot
COPY --from=build /out/inventory /inventory
USER nonroot:nonroot
EXPOSE 8110 9110
HEALTHCHECK --interval=5s --timeout=3s --retries=10 CMD ["/inventory", "healthcheck"]
ENTRYPOINT ["/inventory"]
