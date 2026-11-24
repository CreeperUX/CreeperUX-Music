# The Sonus server's image (ghcr.io/creeperux/sonus-server): the frozen Navidrome image with the gateway in front.
# Everything of Navidrome's image stays as it was (its environment, /data, /music, port 4533); only the entrypoint is
# the gateway now, which runs /app/navidrome behind it. Built from server/ (see README.md):
#   docker build --build-arg SONUS_GIT_SHA=$(git rev-parse HEAD) -t sonus-server server
ARG NAVIDROME_IMAGE=ghcr.io/creeperux/navidrome:latest

# Built on the build machine for the target's architecture, with no emulation (QEMU): rust-lld links a static musl
# binary by itself. One dependency is C, SQLite (rusqlite's bundled copy, so it has FTS5 whatever the image's own
# SQLite has): clang compiles it for the target, against the target's own musl headers, which apk installs into
# /sysroot from Alpine's packages for that architecture (signed, checked with Alpine's keys for it).
FROM --platform=$BUILDPLATFORM rust:1-alpine AS build
ARG TARGETARCH
RUN case "$TARGETARCH" in \
        amd64) echo x86_64 ;; \
        arm64) echo aarch64 ;; \
        *) echo "no Rust target for $TARGETARCH" >&2; exit 1 ;; \
    esac > /arch && \
    echo "$(cat /arch)-unknown-linux-musl" > /rust-target && \
    rustup target add "$(cat /rust-target)" && \
    apk add --no-cache clang llvm musl-dev && \
    apk add --no-cache --root /sysroot --initdb --arch "$(cat /arch)" --keys-dir "/usr/share/apk/keys/$(cat /arch)" \
        --repositories-file /etc/apk/repositories musl-dev
WORKDIR /src
COPY Cargo.toml Cargo.lock ./
COPY src ./src
# the commit, for the version the server reports ("0.1.0 (abc1234)"); last, so it only rebuilds this layer
ARG SONUS_GIT_SHA=""
# rust-lld only when the target is not the build machine's own: set for that one too, it would also link the build's
# proc macros (host libraries, which need the system's linker and libc), and fail.
RUN target="$(cat /rust-target)" && host="$(rustc -vV | sed -n 's/^host: //p')" && under="$(echo "$target" | tr '-' '_')" && \
    if [ "$target" != "$host" ]; then export "CARGO_TARGET_$(echo "$target" | tr 'a-z-' 'A-Z_')_LINKER=rust-lld"; fi && \
    export "CC_$under=clang" "AR_$under=llvm-ar" "CFLAGS_$under=--target=$(cat /arch)-alpine-linux-musl --sysroot=/sysroot" && \
    SONUS_GIT_SHA="$SONUS_GIT_SHA" cargo build --release --locked --target "$target" && \
    cp "target/$target/release/sonus-server" /sonus-server

FROM ${NAVIDROME_IMAGE}
LABEL org.opencontainers.image.source="https://github.com/CreeperUX/Sonus" \
      org.opencontainers.image.licenses="AGPL-3.0-only" \
      org.opencontainers.image.title="Sonus server"
COPY --from=build /sonus-server /app/sonus-server
ENTRYPOINT ["/app/sonus-server"]
