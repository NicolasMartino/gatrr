# Stage 1: Build Tailwind CSS
FROM node:20-slim AS css-builder

WORKDIR /app

# Copy package files and Tailwind config
COPY portal/package*.json portal/tailwind.config.js ./
COPY portal/styles ./styles
COPY portal/templates ./templates

# Install dependencies and build CSS
RUN npm ci && npm run build:css

# Stage 2: Build Rust binary
# Use bookworm variant to match runtime GLIBC version (2.36)
FROM rust:1.92-bookworm AS builder

WORKDIR /app

# Copy manifests
COPY portal/Cargo.toml portal/Cargo.lock ./

# Copy source code
COPY portal/src ./src
COPY portal/templates ./templates

# Build application (only the main portal binary, not dev tools)
RUN cargo build --release --bin portal

# Stage 3: Runtime
FROM debian:bookworm-slim

RUN apt-get update && \
    apt-get install -y ca-certificates curl && \
    rm -rf /var/lib/apt/lists/* && \
    useradd -r -u 1000 -s /bin/false portal

WORKDIR /app

# Copy binary
COPY --from=builder /app/target/release/portal .

# Copy static assets (logos, vendor JS)
COPY portal/static ./static

# Copy built CSS from css-builder stage
COPY --from=css-builder /app/static/css/styles.css ./static/css/

# Set ownership and switch to non-root user
RUN chown -R portal:portal /app
USER portal

EXPOSE 3000

CMD ["./portal"]
