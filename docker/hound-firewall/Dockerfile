FROM alpine:3.24@sha256:28bd5fe8b56d1bd048e5babf5b10710ebe0bae67db86916198a6eec434943f8b

RUN apk add --no-cache iptables=1.8.13-r0

COPY firewall.sh /usr/local/bin/hound-firewall

HEALTHCHECK --interval=10s --timeout=3s --start-period=3s --retries=5 \
  CMD test -f /tmp/firewall-ready && iptables -C OUTPUT -d 169.254.0.0/16 -j REJECT

ENTRYPOINT ["/usr/local/bin/hound-firewall"]
