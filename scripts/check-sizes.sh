#!/usr/bin/env bash
set -euo pipefail

agent_doc_limit=40960
file_limit=1048576
allowlist=.size-allowlist

patterns=()
if [[ -f $allowlist ]]; then
	while IFS= read -r line || [[ -n $line ]]; do
		line=${line%%#*}
		line=${line#"${line%%[![:space:]]*}"}
		line=${line%"${line##*[![:space:]]}"}
		[[ -n $line ]] && patterns+=("$line")
	done <"$allowlist"
fi

allowed() {
	local pattern
	for pattern in "${patterns[@]}"; do
		# shellcheck disable=SC2053
		[[ $1 == $pattern ]] && return 0
	done
	return 1
}

offenders=0
while IFS= read -r -d '' path; do
	[[ -f $path ]] || continue
	size=$(wc -c <"$path")
	size=${size//[[:space:]]/}
	case ${path##*/} in
	CLAUDE.md | AGENT.md | AGENTS.md)
		if ((size > agent_doc_limit)); then
			echo "$path: $size bytes, over the $agent_doc_limit byte limit for agent instructions"
			offenders=$((offenders + 1))
		fi
		;;
	*)
		if ((size > file_limit)) && ! allowed "$path"; then
			echo "$path: $size bytes, over the $file_limit byte limit and not in $allowlist"
			offenders=$((offenders + 1))
		fi
		;;
	esac
done < <(git ls-files -z)

if ((offenders > 0)); then
	echo "$offenders file(s) too large"
	exit 1
fi
echo "All tracked files are within size limits"
