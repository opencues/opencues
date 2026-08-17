// `opencues completion <bash|zsh|fish>` — print a shell completion
// script. User pipes it into their shell config:
//   opencues completion bash >> ~/.bashrc

'use strict';

// Keep in step with the help tree in help.cjs — a command missing here still
// runs, it just never tab-completes, which reads as "that command doesn't
// exist". `extract-commitments` is deliberately absent: hosts kick it, users
// don't type it.
const COMMANDS = [
  'install', 'uninstall', 'seed-configs', 'update-configs', 'init', 'new', 'run',
  'validate', 'import', 'review', 'doctor', 'usage', 'edit', 'logs', 'list', 'show',
  'set-key', 'check-keys', 'models', 'update', 'debug', 'completion',
  'config', 'identity', 'calendar', 'context', 'cleanup', 'sync', 'dismissals',
  'which', 'version', 'help',
];
const HOSTS = ['claude-code', 'claudecode', 'claude', 'cc', 'opencode', 'oc', 'chrome', 'gemini-cli', 'geminicli', 'gemini', 'shell', 'term', 'oc-edit', 'dsh', 'deepseek', 'deepseek-harness'];
const KINDS = ['cue', 'blank'];
const FILES = ['cues', 'blanks', 'opencues'];

module.exports = function completion(argv) {
  if (argv.includes('--help') || argv.includes('-h')) return printHelp();
  const shell = argv.find(a => !a.startsWith('-'));
  if (!shell) {
    console.error('opencues completion: missing <shell>. One of: bash, zsh, fish');
    process.exit(2);
  }
  if (shell === 'bash')      console.log(bashScript());
  else if (shell === 'zsh')  console.log(zshScript());
  else if (shell === 'fish') console.log(fishScript());
  else { console.error(`opencues completion: unknown shell "${shell}"`); process.exit(2); }
};

function bashScript() {
  return `# opencues bash completion. Source from ~/.bashrc:
#   eval "$(opencues completion bash)"
_opencues_completions() {
  local cur prev cmd
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"
  cmd="\${COMP_WORDS[1]}"
  if [ "$COMP_CWORD" -eq 1 ]; then
    COMPREPLY=( $(compgen -W "${COMMANDS.join(' ')}" -- "$cur") )
    return
  fi
  case "$cmd" in
    install|uninstall|run)
      COMPREPLY=( $(compgen -W "${HOSTS.join(' ')} --all --target --dry-run --help" -- "$cur") ) ;;
    new)
      if [ "$COMP_CWORD" -eq 2 ]; then
        COMPREPLY=( $(compgen -W "${KINDS.join(' ')}" -- "$cur") )
      else
        COMPREPLY=( $(compgen -W "--project --dry-run --help" -- "$cur") )
      fi ;;
    edit|debug)
      COMPREPLY=( $(compgen -W "${FILES.join(' ')} --project --help" -- "$cur") ) ;;
    completion)
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "$cur") ) ;;
    *)
      COMPREPLY=( $(compgen -W "--help --dry-run --project" -- "$cur") ) ;;
  esac
}
complete -F _opencues_completions opencues
`;
}

function zshScript() {
  return `# opencues zsh completion. Source from ~/.zshrc:
#   eval "$(opencues completion zsh)"
_opencues() {
  local -a commands hosts kinds files
  commands=(${COMMANDS.map(c => `'${c}'`).join(' ')})
  hosts=(${HOSTS.map(h => `'${h}'`).join(' ')})
  kinds=(${KINDS.map(k => `'${k}'`).join(' ')})
  files=(${FILES.map(f => `'${f}'`).join(' ')})
  if (( CURRENT == 2 )); then
    _describe -t commands 'opencues commands' commands
    return
  fi
  case "\${words[2]}" in
    install|uninstall|run) _describe -t hosts 'host' hosts ;;
    new)                    _describe -t kinds 'kind' kinds ;;
    edit|debug)             _describe -t files 'file' files ;;
    completion)             _values 'shell' bash zsh fish ;;
  esac
}
compdef _opencues opencues
`;
}

function fishScript() {
  return `# opencues fish completion. Save to ~/.config/fish/completions/opencues.fish:
#   opencues completion fish > ~/.config/fish/completions/opencues.fish
${COMMANDS.map(c => `complete -f -c opencues -n "__fish_use_subcommand" -a "${c}"`).join('\n')}
${HOSTS.map(h => `complete -f -c opencues -n "__fish_seen_subcommand_from install uninstall run" -a "${h}"`).join('\n')}
${KINDS.map(k => `complete -f -c opencues -n "__fish_seen_subcommand_from new" -a "${k}"`).join('\n')}
${FILES.map(f => `complete -f -c opencues -n "__fish_seen_subcommand_from edit debug" -a "${f}"`).join('\n')}
complete -f -c opencues -l help -l dry-run -l project
`;
}

function printHelp() {
  console.log('opencues completion <bash|zsh|fish>');
  console.log('');
  console.log('Print a shell completion script. Pipe into your shell config:');
  console.log('  bash:  eval "$(opencues completion bash)"      (or append to ~/.bashrc)');
  console.log('  zsh:   eval "$(opencues completion zsh)"       (or append to ~/.zshrc)');
  console.log('  fish:  opencues completion fish > ~/.config/fish/completions/opencues.fish');
}
