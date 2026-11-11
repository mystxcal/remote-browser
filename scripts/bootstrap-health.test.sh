#!/usr/bin/env bash
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
bootstrap="${script_dir}/bootstrap.sh"
base=$(mktemp -d)
trap 'rm -rf "$base"' EXIT
mkdir -p "$base/bin"

cat > "$base/bin/docker" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
case "$*" in
  'compose version') exit 0 ;;
  'compose up --detach --build') exit 0 ;;
  'compose port gateway 3000') printf '%s\n' "$TEST_PUBLISHED" ;;
  'compose ps') exit 0 ;;
  *) printf 'Unexpected docker args: %s\n' "$*" >&2; exit 1 ;;
esac
MOCK
cat > "$base/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "${@: -1}" > "$TEST_CURL_URL_FILE"
printf '{"ok":true,"browser":true}\n'
MOCK
chmod +x "$base/bin/docker" "$base/bin/curl"

check() {
  local label=$1 published=$2 expected=$3
  local dir="$base/$label"
  mkdir -p "$dir"
  printf 'MIRROR_ACCESS_PASSWORD=test-password\n' > "$dir/.env"
  (
    cd "$dir"
    export PATH="$base/bin:$PATH"
    export TEST_PUBLISHED="$published"
    export TEST_CURL_URL_FILE="$dir/requested-url"
    bash "$bootstrap" > "$dir/output" 2>&1
  )
  local actual
  actual=$(cat "$dir/requested-url")
  if [[ "$actual" != "$expected" ]]; then
    printf 'FAIL %s: got %s, expected %s\n' "$label" "$actual" "$expected" >&2
    return 1
  fi
  printf 'PASS %s\n' "$label"
}

check loopback '127.0.0.1:8080' 'http://127.0.0.1:8080/healthz'
check explicit-ipv4 '192.0.2.55:8080' 'http://192.0.2.55:8080/healthz'
check wildcard-ipv4 '0.0.0.0:8080' 'http://127.0.0.1:8080/healthz'
check explicit-ipv6 '[2001:db8::1]:8080' 'http://[2001:db8::1]:8080/healthz'
check wildcard-ipv6 '[::]:8080' 'http://[::1]:8080/healthz'
