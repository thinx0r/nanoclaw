#!/usr/bin/env bash
# cleanup stub
find /opt/nanoclaw-sheldon/data/sessions -name "*.jsonl" -mtime +30 -delete 2>/dev/null || true
exit 0
