#!/usr/bin/env bash
# Build a ROS 2 message package into msg_packages/ so CAT can decode its types without rebuilding
# the pyworker image. Run on the host that runs CAT (needs docker compose).
#
#   scripts/build_msg_package.sh /path/to/my_msgs        # a package directory (has package.xml)
#   scripts/build_msg_package.sh /path/to/workspace/src  # a folder containing several packages
#
# Then re-open the recording in CAT (a "not decoded" topic is rebuilt the next time the cache is
# built: evict it from EVIL's cache, or just upload/open a new recording).
set -euo pipefail

src="${1:?usage: $0 <package dir | folder of packages>}"
src="$(cd "$src" && pwd)"
root="$(cd "$(dirname "$0")/.." && pwd)"
mkdir -p "$root/msg_packages"

[[ -f "$src/package.xml" || -n "$(find "$src" -maxdepth 3 -name package.xml -print -quit)" ]] \
  || { echo "no package.xml under $src" >&2; exit 1; }

cd "$root"
docker compose -f docker-compose.yml -f docker-compose.evil.yml run --rm --no-deps \
  -v "$src:/src:ro" pyworker bash -c '
    set -e
    source /opt/ros/humble/setup.bash
    source /ros_ws/install/setup.bash
    cd /ros_ws/extra
    colcon build --base-paths /src --build-base build --install-base install \
      --cmake-args -DCMAKE_BUILD_TYPE=Release
    echo "installed:"; ls install | grep -v -E "^(COLCON_IGNORE|_local_setup_util|local_setup|setup|.*\.(sh|bash|zsh|ps1))$"
  '
echo "Done. New types are used by the next cache build."
