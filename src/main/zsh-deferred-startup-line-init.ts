// Why: user startup files can replace the prompt array and global zshrc can rebind line-init.
export const ZSH_DEFERRED_LINE_INIT_BLOCK = `__orca_deferred_line_init() {
  builtin emulate -L zsh
  (( \${+functions[__orca_deferred_init]} )) || return 0
  local __orca_direct_line_init=0
  [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]] && __orca_direct_line_init=1
  __orca_deferred_init
  if (( __orca_direct_line_init && \${+widgets[zle-line-init]} )); then
    zle zle-line-init "$@"
  elif [[ "\${widgets[zle-line-init]:-}" == user:__orca_prompt_mark ]]; then
    local __orca_prev_line_init_fn=""
    __orca_prompt_mark "$@"
  fi
}
__orca_deferred_precmd() {
  local __orca_precmd_status=0
  if (( \${+functions[__orca_saved_precmd]} )); then
    local __orca_original_precmd="\${functions[__orca_saved_precmd]}"
    functions[precmd]="$__orca_original_precmd"
    precmd "$@"
    __orca_precmd_status=$?
    if (( \${+functions[__orca_deferred_init]} )) &&
       [[ "\${functions[precmd]:-}" == "$__orca_original_precmd" ]]; then
      functions[precmd]="\${functions[__orca_deferred_precmd]}"
    fi
  fi
  __orca_deferred_precmd_fallback
  return $__orca_precmd_status
}
__orca_deferred_precmd_fallback() {
  builtin emulate -L zsh
  if (( \${+functions[__orca_deferred_init]} && ! precmd_functions[(Ie)__orca_deferred_init] )); then
    __orca_deferred_init
  fi
}
__orca_arm_deferred_line_init() {
  builtin emulate -L zsh
  if [[ "\${widgets[zle-line-init]:-}" != user:__orca_deferred_line_init ]]; then
    if (( \${+widgets[zle-line-init]} )); then
      zle -A zle-line-init __orca_saved_line_init
    fi
    zle -N zle-line-init __orca_deferred_line_init
  fi
  if [[ "\${functions[precmd]:-}" != "\${functions[__orca_deferred_precmd]}" ]]; then
    if (( \${+functions[precmd]} )); then
      functions[__orca_saved_precmd]="\${functions[precmd]}"
    fi
    functions[precmd]="\${functions[__orca_deferred_precmd]}"
  fi
}`

// Why: restore the exact prior widget before the existing readiness hook captures it.
export const ZSH_DEFERRED_LINE_INIT_RETIRE_BLOCK = `  if [[ "\${functions[precmd]:-}" == "\${functions[__orca_deferred_precmd]}" ]]; then
    if (( \${+functions[__orca_saved_precmd]} )); then
      functions[precmd]="\${functions[__orca_saved_precmd]}"
    else
      builtin unfunction precmd
    fi
  fi
  if (( \${+widgets[__orca_saved_line_init]} )); then
    if [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]]; then
      zle -A __orca_saved_line_init zle-line-init
    fi
    zle -D __orca_saved_line_init
  elif [[ "\${widgets[zle-line-init]:-}" == user:__orca_deferred_line_init ]]; then
    zle -D zle-line-init
  fi`

// Why: add-zle-hook-widget can keep an alias of the bootstrap in its own chain.
export const ZSH_DEFERRED_LINE_INIT_CLEANUP_BLOCK = `  builtin unfunction __orca_deferred_precmd __orca_deferred_precmd_fallback
  (( \${+functions[__orca_saved_precmd]} )) && builtin unfunction __orca_saved_precmd
  local __orca_widget __orca_line_init_bound=0
  for __orca_widget in "\${(v)widgets[@]}"; do
    if [[ "$__orca_widget" == user:__orca_deferred_line_init ]]; then
      __orca_line_init_bound=1
      break
    fi
  done
  (( __orca_line_init_bound )) || builtin unfunction __orca_deferred_line_init`
