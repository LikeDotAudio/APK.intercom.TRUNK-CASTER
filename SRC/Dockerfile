# Trunk-Caster back end in containers.
#
# Two images from one build:
#   target: caster     the runtime (pages + API on 8080, Ward-Beck port 7879)
#   target: frame-sim  one intercom simulator, hosting one protocol's frames,
#                      speaking Ward-Beck crosspoint lines to the caster
#
# Build context is the project root because the crates depend on the SDK by
# relative path. Only the crates are copied in; the data folders (manuals,
# TRUNK-*) are mounted at run time.
#
#   docker compose up --build -d                  # the caster, one interface
#   docker compose --profile sims up --build -d   # plus one container per protocol
#   open http://127.0.0.1:8080/

# ---- build stage ----------------------------------------------------------
FROM rust:1-slim-bookworm AS build
WORKDIR /src
COPY TRUNK-CASTER-SDK TRUNK-CASTER-SDK
COPY RUST-RUNTIME RUST-RUNTIME
COPY TRUNK-SIMULATOR/frame-sim TRUNK-SIMULATOR/frame-sim
RUN cd RUST-RUNTIME && cargo build --release && cargo test --release 2>&1 | tail -2
RUN cd TRUNK-SIMULATOR/frame-sim && cargo build --release

# ---- caster ---------------------------------------------------------------
FROM debian:bookworm-slim AS caster
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --system --uid 10001 --create-home caster
COPY --from=build /src/RUST-RUNTIME/target/release/trunk-caster /usr/local/bin/trunk-caster
# /voices: the frames' re-assembled voices (TRUNK_VOICES_DIR), on a volume.
RUN mkdir -p /voices && chown caster /voices
VOLUME ["/data", "/voices"]
ENV TRUNK_ROOT=/data \
    TRUNK_SITE=trunk-caster \
    TRUNK_BIND=0.0.0.0 \
    TRUNK_PORT=8080 \
    TRUNK_WB_PORT=7879 \
    TRUNK_PUBLIC_URL=http://127.0.0.1:8080
EXPOSE 8080 7879
USER caster
HEALTHCHECK --interval=15s --timeout=3s --start-period=10s \
  CMD curl -fs http://127.0.0.1:${TRUNK_PORT}/api/status > /dev/null || exit 1
ENTRYPOINT ["trunk-caster"]
CMD ["serve"]

# ---- frame-sim ------------------------------------------------------------
FROM debian:bookworm-slim AS frame-sim
# espeak-ng: each frame speaks its ident and its connections.
RUN apt-get update && apt-get install -y --no-install-recommends espeak-ng  && rm -rf /var/lib/apt/lists/*  && useradd --system --uid 10002 --create-home sim
COPY --from=build /src/TRUNK-SIMULATOR/frame-sim/target/release/frame-sim /usr/local/bin/frame-sim
ENV SIM_PROTOCOL=dante \
    SIM_FRAMES=10 \
    SIM_SITE=trunk-caster \
    SIM_CASTER=trunk-caster:7879 \
    SIM_CHECKIN_SECONDS=20     SIM_VOICE_DIR=/home/sim/voices
USER sim
ENTRYPOINT ["frame-sim"]
