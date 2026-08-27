#!/bin/bash
# zig-cc kernel wrapper: implements zinux W01/W02 as a shell wrapper.
# W01: -S + -Wp,-MD → split into two passes (zig cc drops the .s otherwise).
# W02: suppress spurious "unused -c" warning on -S passes (kernel promotes
#      it to an error; we already removed those -Werror flags, this is safety).
args=()
dep=""
prev=""
is_S=0; is_c=0; is_E=0
for a in "$@"; do
  case "$a" in
    -S) is_S=1 ;;
    -c) is_c=1 ;;
    -E) is_E=1 ;;
  esac
  if [ "$prev" = "-o" ]; then out="$a"; fi
  case "$a" in
    -Wp,-MD,*|-Wp,-MMD,*) dep="${a#-Wp,-M*}"; dep="${a:7}"; args+=() ;; # skip
    *) args+=("$a") ;;
  esac
  prev="$a"
done
# recompute dep properly
dep=""
for a in "$@"; do
  case "$a" in
    -Wp,-MD,*) dep="${a#-Wp,-MD,}" ;;
    -Wp,-MMD,*) dep="${a#-Wp,-MMD,}" ;;
  esac
done

# W03: link steps (.o inputs or -Wl, without -c/-E/-S) go to system clang,
# which passes linker flags through cleanly.  UML links via CC and needs
# -Wl,--wrap.  System lld + zinux patch 0005 handle the UML script.
if [ $is_c = 0 ] && [ $is_E = 0 ] && [ $is_S = 1 -o $is_S = 0 ]; then
  for a in "$@"; do
    case "$a" in
      *.o|-Wl,*|-nostdlib|-shared|-static|-pie|-l*) 
        exec clang --target=x86_64-linux-gnu "$@" ;;
    esac
  done
fi

if [ $is_S = 1 ] && [ -n "$dep" ]; then
  # pass 1: assembly only
  zig cc "${args[@]}" || exit $?
  # pass 2: deps only (best-effort, like clang)
  dargs=()
  skip=0
  for a in "$@"; do
    if [ $skip = 1 ]; then skip=0; continue; fi
    case "$a" in
      -S|-fverbose-asm) continue ;;
      -Wp,-MD,*|-Wp,-MMD,*) continue ;;
      -o) skip=1; continue ;;
    esac
    dargs+=("$a")
  done
  zig cc -M -MF "$dep" "${dargs[@]}" 2>/dev/null
  exit 0
fi

exec zig cc "$@"
