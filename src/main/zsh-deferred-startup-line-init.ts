// Why: user startup files can replace precmd_functions after Orca registers its hook.
export const ZSH_DEFERRED_LINE_INIT_BLOCK = `__orca_deferred_line_init() {
  builtin emulate -L zsh
  (( \${+functions[__orca_deferred_init]} )) && __orca_deferred_init
  if (( \${+widgets[zle-line-init]} )) && [[ "\${widgets[zle-line-init]}" != user:__orca_deferred_line_init ]]; then
    zle zle-line-init "$@"
  fi
}
__orca_arm_deferred_line_init() {
  builtin emulate -L zsh
  [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]] && return 0
  if (( \${+widgets[zle-line-init]} )); then
    zle -A zle-line-init __orca_saved_line_init
  fi
  zle -N zle-line-init __orca_deferred_line_init
}`

// Why: restore the exact prior widget before the existing readiness hook captures it.
export const ZSH_DEFERRED_LINE_INIT_RETIRE_BLOCK = `  if (( \${+widgets[__orca_saved_line_init]} )); then
    if [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]]; then
      zle -A __orca_saved_line_init zle-line-init
    fi
    zle -D __orca_saved_line_init
  elif [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]]; then
    zle -D zle-line-init
  fi`
