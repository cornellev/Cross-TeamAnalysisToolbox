# Extra message packages

Pre-built ROS 2 install spaces for message packages that are NOT baked into the pyworker image.
Mounted at `/ros_ws/extra` (see `docker-compose.evil.yml`); every cache build runs in a fresh
process that puts `install/*` on its path, so a new package needs `scripts/build_msg_package.sh`,
not an image rebuild. Without it, messages of that type are still cached (stored undecoded) and the
topic is marked "not decoded" in CAT. Contents are build output, not committed.
