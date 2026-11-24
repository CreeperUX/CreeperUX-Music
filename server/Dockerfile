# The Sonus server's image (ghcr.io/creeperux/sonus-server): the frozen Navidrome image with the gateway in front.
# Everything of Navidrome's image stays as it was (its environment, /data, /music, port 4533); only the entrypoint is
# the gateway now, which runs /app/navidrome behind it. Built from server/ (see README.md):
#   docker build --build-arg SONUS_GIT_SHA=$(git rev-parse HEAD) -t sonus-server server
ARG NAVIDROME_IMAGE=ghcr.io/creeperux/navidrome:latest

# Built on the build machine for the target's architecture: the dependencies are pure Rust, so rust-lld links a static
# musl binary by itself, with no C toolchain for the target and no emulation (QEMU).
FROM --platform=$BUILDPLATFORM rust:1-alpine AS build
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) echo x86_64-unknown-linux-musl ;; \
        arm64) echo aarch64-unknown-linux-musl ;; \
        *) echo "no Rust target for $TARGETARCH" >&2; exit 1 ;; \
    esac > /rust-target && \
    rustup target add "$(cat /rust-target)"
ENV CARGO_TARGET_X86_64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld \
    CARGO_TARGET_AARCH64_UNKNOWN_LINUX_MUSL_LINKER=rust-lld
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# the commit, for the version the server reports ("0.1.0 (abc1234)"); last, so it only rebuilds this layer
ARG SONUS_GIT_SHA=""
RUN SONUS_GIT_SHA="$SONUS_GIT_SHA" cargo build --release --locked --target "$(cat /rust-target)" && \
    cp "target/$(cat /rust-target)/release/sonus-server" /sonus-server

FROM ${NAVIDROME_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/CreeperUX/Sonus" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="Sonus server"
COPY --from=build /sonus-server /app/sonus-server
ENTRYPOINT ["/app/sonus-server"]
