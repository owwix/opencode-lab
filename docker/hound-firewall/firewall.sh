#!/bin/sh
set -eu

# Hound shares this container's network namespace. Allow replies to the relay
# and local Docker DNS, then reject every non-public IPv4 destination. The
# kernel applies these rules after DNS resolution and again to redirect targets.
rm -f /tmp/firewall-ready
iptables -P OUTPUT DROP
ip6tables -P OUTPUT DROP
iptables -F OUTPUT
ip6tables -F OUTPUT
iptables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
iptables -A OUTPUT -o lo -j ACCEPT

for subnet in \
  0.0.0.0/8 \
  10.0.0.0/8 \
  100.64.0.0/10 \
  127.0.0.0/8 \
  169.254.0.0/16 \
  172.16.0.0/12 \
  192.0.0.0/24 \
  192.0.2.0/24 \
  192.88.99.0/24 \
  192.168.0.0/16 \
  198.18.0.0/15 \
  198.51.100.0/24 \
  203.0.113.0/24 \
  224.0.0.0/4 \
  240.0.0.0/4
do
  iptables -A OUTPUT -d "$subnet" -j REJECT
done

# The Compose bridge is IPv4-only. Fail closed if IPv6 becomes available so
# unique-local, link-local, or mapped addresses cannot bypass the IPv4 rules.
ip6tables -A OUTPUT -m conntrack --ctstate ESTABLISHED,RELATED -j ACCEPT
ip6tables -A OUTPUT -o lo -j ACCEPT

# Public IPv4 egress is enabled only after every blocking rule was installed.
# With `set -e`, any earlier failure leaves both protocol families fail-closed.
iptables -P OUTPUT ACCEPT
touch /tmp/firewall-ready
exec tail -f /dev/null
