# RIO X MD: Node bot + Go "callbot" (real call answering) + ffmpeg.
# Stage 1: build the Go call service. `go mod tidy` fetches the newest whatsmeow / meowcaller.
FROM golang:1.24-bookworm AS callbot
ENV GOTOOLCHAIN=auto CGO_ENABLED=0
WORKDIR /src
COPY callbot/ ./
RUN go mod tidy && go build -trimpath -ldflags="-s -w" -o /out/callbot .

# Stage 2: the bot itself.
FROM node:20-bookworm-slim
RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg ca-certificates \
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
