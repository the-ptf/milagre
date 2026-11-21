#!/bin/bash
# trace-exec.sh <log> <command> [args...]: runs the command and appends "<own pid> <exit status> <children's user> <children's sys>" to the log.
log=$1
shift
"$@" <&0 &
child=$!
trap 'kill -TERM $child 2>/dev/null' TERM INT HUP
while :; do
  wait $child
  status=$?
  kill -0 $child 2>/dev/null || break
done
times >"$log.$$"
{
  read -r _
  read -r user sys
} <"$log.$$"
rm -f "$log.$$"
echo "$$ $status $user $sys" >>"$log"
exit $status
