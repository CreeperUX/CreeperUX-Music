#!/bin/sh
# navidrome-ctl: the only program the CreeperUX agent's SSH key may run on the server (tools/server/README.md sets it
# up). authorized_keys pins it with command="sudo -n /usr/local/bin/navidrome-ctl \"$SSH_ORIGINAL_COMMAND\"", and a
# sudoers rule lets the agent's user run this one program as root and nothing else; the user is not in the docker
# group. Whatever the key asks for, this runs, and it does only what is listed below for one Navidrome service: look
# (status, logs, version, check), back up its data folder, and switch its image between the CreeperUX fork and
# upstream. No shell, no file access, no other containers, no restore (restoring a backup is left to you). Every call
# goes to syslog (tag navidrome-ctl), and sudo logs it too.
#
# Install it root-owned, so the agent's user cannot change it:
#   sudo install -o root -g root -m 755 navidrome-ctl.sh /usr/local/bin/navidrome-ctl
set -eu

# ---- set these for your server ------------------------------------------------------------------------------------
COMPOSE_DIR=/opt/navidrome              # the folder with Navidrome's compose file
SERVICE=navidrome                       # its service name in that file
DATA_DIR=/opt/navidrome/data            # Navidrome's data folder on the host (mounted as /data)
BACKUP_DIR=/opt/navidrome/backups       # where backups are written (created if missing)
FORK_IMAGE=ghcr.io/creeperux/navidrome:latest
KEEP_BACKUPS=5                          # older ones made by this script are deleted
# ------------------------------------------------------------------------------------------------------------------

MARK="# written by navidrome-ctl (CreeperUX): delete this file to go back to the image in the main compose file"
request=${SSH_ORIGINAL_COMMAND:-${*:-help}}
logger -t navidrome-ctl "from ${SSH_CLIENT:-local}: $request" 2>/dev/null || true
set -f; set -- $request; set +f # split into words, with no globbing of them
action=${1:-help}

cd "$COMPOSE_DIR"
# the override file docker compose loads next to the main one
if [ -f compose.yaml ] || [ -f compose.yml ]; then OVERRIDE=compose.override.yaml; else OVERRIDE=docker-compose.override.yml; fi

container() { docker compose ps -q "$SERVICE"; }
image_in_use() { c=$(container); [ -n "$c" ] && docker inspect --format '{{.Config.Image}}' "$c" || echo "(not running)"; }
ours() { [ -f "$OVERRIDE" ] && head -n 1 "$OVERRIDE" | grep -qF "$MARK"; }
recent_backup() { find "$BACKUP_DIR" -maxdepth 1 -name 'navidrome-data-*.tar.gz' -mmin -1440 2>/dev/null | head -n 1; }

case "$action" in
  help)
    echo "navidrome-ctl: status | logs [lines] | version | check | backup | use-fork | use-upstream"
    ;;
  status)
    docker compose ps "$SERVICE"
    echo "image in use: $(image_in_use)"
    if ours; then echo "override: $OVERRIDE (the CreeperUX fork)"; elif [ -f "$OVERRIDE" ]; then echo "override: $OVERRIDE (yours, not touched)"; else echo "override: none (the main compose file's image)"; fi
    echo "backups:"; ls -1t "$BACKUP_DIR"/navidrome-data-*.tar.gz 2>/dev/null | head -n "$KEEP_BACKUPS" || echo "  none"
    df -h "$BACKUP_DIR" 2>/dev/null | tail -n 1 || true
    ;;
  logs)
    lines=${2:-100}
    case "$lines" in ''|*[!0-9]*) echo "logs: lines must be a number" >&2; exit 2 ;; esac
    [ "$lines" -le 1000 ] || lines=1000
    docker compose logs --no-color --tail "$lines" "$SERVICE"
    ;;
  version)
    docker compose exec -T "$SERVICE" /app/navidrome --version
    ;;
  check)
    # what anyone can ask without signing in: the extensions (Sonus Connect is one), and rest/connect refusing
    # a request with no credentials
    docker compose exec -T "$SERVICE" sh -c '
      base="http://localhost:${ND_PORT:-4533}"
      case "${ND_BASEURL:-}" in /*) base="$base${ND_BASEURL%/}" ;; esac
      echo "extensions: $(curl -s "$base/rest/getOpenSubsonicExtensions.view?f=json")"
      echo "connect without credentials: $(curl -s -o /dev/null -w "HTTP %{http_code}" "$base/rest/connect.view?f=json") $(curl -s "$base/rest/connect.view?f=json" | head -c 200)"'
    ;;
  backup)
    mkdir -p "$BACKUP_DIR"
    file="navidrome-data-$(date +%Y%m%d-%H%M%S).tar.gz"
    echo "stopping $SERVICE for a consistent copy of its database…"
    docker compose stop "$SERVICE"
    status=0
    # the database and settings; not the caches (images, transcodings), which Navidrome builds again
    docker run --rm -v "$DATA_DIR":/data:ro -v "$BACKUP_DIR":/backup alpine:3.22 tar czf "/backup/$file" --exclude=./cache -C /data . || status=$?
    docker compose start "$SERVICE"
    [ "$status" -eq 0 ] || { echo "backup failed ($status); $SERVICE started again" >&2; exit "$status"; }
    ls -lh "$BACKUP_DIR/$file"
    ls -1t "$BACKUP_DIR"/navidrome-data-*.tar.gz | tail -n +"$((KEEP_BACKUPS + 1))" | while read -r old; do rm -f "$old"; done
    ;;
  use-fork)
    [ -n "$(recent_backup)" ] || { echo "use-fork: back up first (navidrome-ctl backup): no backup from the last 24 hours" >&2; exit 3; }
    if [ -f "$OVERRIDE" ] && ! ours; then echo "use-fork: $OVERRIDE is yours; not touching it" >&2; exit 4; fi
    printf '%s\nservices:\n  %s:\n    image: %s\n' "$MARK" "$SERVICE" "$FORK_IMAGE" > "$OVERRIDE"
    docker compose pull "$SERVICE"
    docker compose up -d "$SERVICE"
    echo "image in use: $(image_in_use)"
    ;;
  use-upstream)
    if ours; then rm -f "$OVERRIDE"; elif [ -f "$OVERRIDE" ]; then echo "use-upstream: $OVERRIDE is yours; not touching it" >&2; exit 4; fi
    docker compose pull "$SERVICE"
    docker compose up -d "$SERVICE"
    echo "image in use: $(image_in_use)"
    ;;
  *)
    echo "navidrome-ctl: unknown request: $action (try help)" >&2
    exit 2
    ;;
esac
