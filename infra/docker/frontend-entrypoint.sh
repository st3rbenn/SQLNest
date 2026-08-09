#!/bin/sh
# Rend /usr/share/nginx/html/config/context.js à partir du template en
# substituant PUBLIC_API_URL. Overwrite le context.js buildé par Vite
# (celui de public/config/ = valeurs dev localhost).
set -eu

: "${PUBLIC_API_URL:?PUBLIC_API_URL doit être défini (ex: https://dev.sqlnest.io)}"

mkdir -p /usr/share/nginx/html/config
envsubst '${PUBLIC_API_URL}' \
    < /usr/share/nginx/html-tpl/context.js.tpl \
    > /usr/share/nginx/html/config/context.js

echo "[entrypoint] context.js rendu avec PUBLIC_API_URL=${PUBLIC_API_URL}"
