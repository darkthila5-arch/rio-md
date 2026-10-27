# RIO X MD: Node bot + Go "callbot" (real call answering) + ffmpeg.
# Stage 1: build the Go call service. `go mod tidy` fetches the newest whatsmeow / meowcaller.
FROM golang:1.24-bookworm AS callbot
ENV GOTOOLCHAIN=auto CGO_ENABLED=0 GOFLAGS=-mod=mod
WORKDIR /src
COPY callbot/ ./
# Print the meowcaller API into the build log (to find the "start a call" function), then try the build with
# outgoing calls (-tags dial); if that does not compile, fall back to the normal build.
RUN echo "cache-bust-2" && go mod tidy \
 && (echo "=== MEOWCALLER API START v2 ==="; go doc -all github.com/purpshell/meowcaller 2>&1 | grep -E "^(func|type|    func)" | head -150; echo "=== MEOWCALLER API END v2 ===") || true
RUN (echo "=== DIAL BUILD v2 ==="; go build -tags dial -trimpath -ldflags="-s -w" -o /out/callbot . ) \
 || (echo "=== DIAL BUILD FAILED, using normal build ==="; go build -trimpath -ldflags="-s -w" -o /out/callbot .)

# Stage 2: the bot itself.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates git \
 && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package*.json ./
RUN npm install --omit=dev
COPY . .
RUN mkdir -p /app/bin
COPY --from=callbot /out/callbot /app/bin/callbot
ENV NODE_ENV=production
EXPOSE 3000
CMD ["node", "index.js"]
