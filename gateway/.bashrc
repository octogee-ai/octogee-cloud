# Colors and terminal
export CLICOLOR=1
export LSCOLORS=ExFxBxDxCxegedabagacad
export TERM=xterm-256color

# History
export HISTSIZE=10000
export HISTFILESIZE=20000
shopt -s histappend
PROMPT_COMMAND="history -a; history -c"

# Aliases
alias ls='ls -lah'
alias ll='ls -lh'
alias grep='grep --color=auto'
alias git-log='git log --oneline -n 20'
alias cd-claw='cd /home/node/.openclaw'
alias cd-users='cd /home/node/.openclaw/customers'

# Git config
git config --global user.email "gateway@octogee.com" 2>/dev/null || true
git config --global user.name "Octogee Gateway" 2>/dev/null || true

# Prompt with colors
export PS1='\[\033[01;32m\]\u@gateway\[\033[00m\]:\[\033[01;34m\]\w\[\033[00m\]\$ '

# fzf (if installed)
[ -f ~/.fzf.bash ] && source ~/.fzf.bash

# Show current directory and helpful info
[ -f /home/node/.openclaw/openclaw.json ] && echo "✓ OpenClaw gateway configured"
[ -d /home/node/.openclaw/customers ] && echo "✓ Users directory ready"
