#!/usr/bin/env bash
# prompt-improve.sh — Benchmark for the prompt improver blank
#
# Runs prompt-blank.sh directly against test cases and prints before/after for review.
# Scored on two axes: SPECIFICITY gain, MEANING preservation.
#
# Usage:
#   GROQ_API_KEY=your-key bash tests/benchmarks/prompt-improve.sh
#   GROQ_API_KEY=your-key bash tests/benchmarks/prompt-improve.sh --category creative
#
# Categories: creative, technical, professional, research, edge

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CUE_MD="$SCRIPT_DIR/../../defaults/blanks/prompt/BLANK.md"
PROMPT_SCRIPT="$SCRIPT_DIR/../../defaults/blanks/prompt/prompt-blank.sh"

FILTER_CATEGORY="${1:-}"
if [[ "$FILTER_CATEGORY" == "--category" ]]; then
  FILTER_CATEGORY="${2:-}"
fi

# --- Extract prompts from cue.md body sections ---
extract_section() {
  local section="$1"
  awk "/^## $section/{found=1; next} /^## /{found=0} found{print}" "$CUE_MD"
}

export CUES_MODEL="${CUES_MODEL:-openai/gpt-oss-120b}"
export CUES_API_URL="${CUES_API_URL:-https://api.groq.com/openai/v1/chat/completions}"
export CUES_API_KEY_ENV="${CUES_API_KEY_ENV:-GROQ_API_KEY}"
export CUES_ALT_COUNT="${CUES_ALT_COUNT:-3}"
export CUES_INCLUDE_ORIGINAL="false"   # benchmark: only judge the improvements
export CUES_PROMPT_EXTRACT="$(extract_section Extract)"
export CUES_PROMPT_TRANSFORM="$(extract_section Transform)"

if [[ -z "${GROQ_API_KEY:-}" ]]; then
  echo "Error: GROQ_API_KEY not set"
  exit 1
fi

PASS=0
FAIL=0
WARN=0
TOTAL=0

# --- Scoring rubric (printed at end) ---
# PASS  — improved specificity, meaning preserved
# WARN  — specificity improved but meaning drifted OR meaning preserved but no specificity gain
# FAIL  — meaning changed significantly, or output is worse than input

sep() { printf '%0.s─' {1..70}; echo; }

run_test() {
  local category="$1"
  local desc="$2"
  local input="$3"
  # expected_intent: a short phrase that ALL outputs must semantically contain
  # used for sanity-check only — a reviewer should judge the full output
  local expected_intent="$4"

  if [[ -n "$FILTER_CATEGORY" && "$FILTER_CATEGORY" != "$category" ]]; then
    return
  fi

  TOTAL=$((TOTAL+1))
  sep
  printf "%-12s %s\n" "[$category]" "$desc"
  echo "  IN : $input"
  echo

  # Run the script — fake "improve prompt" as the keyword, rest is context
  output=$(bash "$PROMPT_SCRIPT" get "improve prompt" improve prompt $input 2>/dev/null || true)

  if [[ -z "$output" ]]; then
    echo "  ✗  (no output — script failed or timed out)"
    FAIL=$((FAIL+1))
    return
  fi

  # Print numbered alternatives
  local i=1
  while IFS= read -r line; do
    printf "  ALT%d: %s\n" "$i" "$line"
    i=$((i+1))
  done <<< "$output"

  echo
  # Automated sanity: does at least one alt contain expected_intent keywords?
  local found_intent=0
  while IFS= read -r line; do
    line_lower=$(echo "$line" | tr '[:upper:]' '[:lower:]')
    intent_lower=$(echo "$expected_intent" | tr '[:upper:]' '[:lower:]')
    # Check each word of the intent appears in the line
    all_found=1
    for word in $intent_lower; do
      if [[ "$line_lower" != *"$word"* ]]; then
        all_found=0
        break
      fi
    done
    if [[ "$all_found" -eq 1 ]]; then
      found_intent=1
      break
    fi
  done <<< "$output"

  # Check for verbatim echo (model returned the input unchanged — no improvement)
  local first_line
  first_line=$(echo "$output" | head -1 | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  local input_lower
  input_lower=$(echo "$input" | tr '[:upper:]' '[:lower:]' | sed 's/^[[:space:]]*//;s/[[:space:]]*$//')
  if [[ "$first_line" == "$input_lower" ]]; then
    echo "  ⚠  verbatim echo: ALT1 is identical to input — model produced no improvement"
    WARN=$((WARN+1))
    return
  fi

  if [[ "$found_intent" -eq 1 ]]; then
    echo "  ✓  intent check passed (\"$expected_intent\" found)"
    PASS=$((PASS+1))
  else
    echo "  ⚠  intent check: \"$expected_intent\" not found in any alt — review meaning preservation"
    WARN=$((WARN+1))
  fi
}

# ─── Creative: poems ────────────────────────────────────────────────────────
run_test "creative" "Vague poem request"                    "write a poem about love"                                          "poem"
run_test "creative" "Haiku (explicit form)"                 "write a haiku about autumn"                                       "haiku"
run_test "creative" "Poem with named subject"               "write a poem about my grandmother"                                "poem"
run_test "creative" "Nature poem"                           "write a poem about the ocean"                                     "poem"
run_test "creative" "Political poem"                        "write a poem about war"                                           "poem"
run_test "creative" "Limerick (explicit form)"              "write a limerick about a cat"                                     "limerick"
run_test "creative" "Sonnet (explicit form)"                "write a sonnet about time passing"                                "sonnet"
run_test "creative" "Poem with emotion"                     "write a sad poem"                                                 "poem"
run_test "creative" "Poem for a child"                      "write a poem for my daughter's birthday"                          "poem"

# ─── Creative: stories & scripts ────────────────────────────────────────────
run_test "creative" "Short story genre unspecified"         "write a short story about a detective"                            "detective"
run_test "creative" "Sci-fi story"                          "write a science fiction story about space travel"                 "space"
run_test "creative" "Horror story"                          "write a scary short story"                                        "stor"
run_test "creative" "Children's story"                      "write a bedtime story for a 5 year old"                           "stor"
run_test "creative" "Scene with dialogue"                   "write a scene where two friends argue"                            "scene"
run_test "creative" "Screenplay opening"                    "write the opening scene of a thriller movie"                      "scene"
run_test "creative" "Flash fiction"                         "write a very short story about a lost key"                        "stor"
run_test "creative" "Fable"                                 "write a fable with a moral lesson"                                "fable"

# ─── Creative: other formats ────────────────────────────────────────────────
run_test "creative" "Song lyrics"                           "write song lyrics about heartbreak"                               "song"
run_test "creative" "Joke"                                  "write me a funny joke"                                            "joke"
run_test "creative" "Toast / speech"                        "write a wedding toast for my best friend"                         "toast"
run_test "creative" "Monologue"                             "write a monologue for a villain"                                  "monologue"

# ─── Technical: debugging ────────────────────────────────────────────────────
run_test "technical" "Vague debug request"                  "help me fix my code"                                              "code"
run_test "technical" "Fix a crash"                          "my app keeps crashing fix it"                                     "crash"
run_test "technical" "Performance issue"                    "my code is slow make it faster"                                   "code"
run_test "technical" "Memory leak"                          "there is a memory leak in my program"                             "memory"
run_test "technical" "Bug in loop"                          "my loop is not working correctly"                                 "loop"
run_test "technical" "Fix failing tests"                    "my tests are failing help me fix them"                            "test"

# ─── Technical: explanation ──────────────────────────────────────────────────
run_test "technical" "Language internals"                   "explain how Python works"                                         "python"
run_test "technical" "Concept explanation"                  "explain what recursion is"                                        "recursion"
run_test "technical" "Concurrency"                          "explain multithreading vs multiprocessing"                        "thread"
run_test "technical" "Networking concept"                   "explain how TCP/IP works"                                         "tcp"
run_test "technical" "Async programming"                    "explain async await"                                              "async"
run_test "technical" "Data structures"                      "explain the difference between a stack and a queue"               "stack"
run_test "technical" "Design pattern"                       "explain the observer pattern"                                     "observer"

# ─── Technical: implementation & architecture ────────────────────────────────
run_test "technical" "Database design"                      "design a database for a blog"                                     "database"
run_test "technical" "Code review"                          "review my function and improve it"                                "function"
run_test "technical" "API integration"                      "show me how to call an API"                                       "api"
run_test "technical" "Auth system"                          "implement user authentication"                                    "auth"
run_test "technical" "REST API design"                      "design a REST API for a to-do app"                                "api"
run_test "technical" "Refactoring"                          "refactor my code to be cleaner"                                   "code"
run_test "technical" "Write unit tests"                     "write unit tests for my function"                                 "test"
run_test "technical" "CI/CD pipeline"                       "set up a CI/CD pipeline"                                         "pipeline"
run_test "technical" "Docker setup"                         "containerise my application with Docker"                          "docker"
run_test "technical" "SQL query"                            "write a SQL query to get all users who signed up last month"       "sql"
run_test "technical" "Regex"                                "write a regex to validate email addresses"                        "regex"
run_test "technical" "Algorithm"                            "write a sorting algorithm"                                        "sort"
run_test "technical" "Security audit"                       "check my code for security vulnerabilities"                       "security"
run_test "technical" "Documentation"                        "write documentation for my API"                                   "api"
run_test "technical" "Code comment"                         "add comments to my code"                                          "comment"

# ─── Professional: emails ────────────────────────────────────────────────────
run_test "professional" "Raise request email"               "write an email to my boss asking for a raise"                     "email"
run_test "professional" "Complaint email"                   "write a complaint email to a supplier"                            "email"
run_test "professional" "Apology email"                     "write an apology email to a client"                               "email"
run_test "professional" "Cold outreach"                     "write a cold email to a potential client"                         "email"
run_test "professional" "Follow-up email"                   "write a follow up email after a job interview"                    "email"
run_test "professional" "Project update email"              "write an email updating stakeholders on project progress"         "email"
run_test "professional" "Resignation email"                 "write a resignation email"                                        "email"

# ─── Professional: documents ────────────────────────────────────────────────
run_test "professional" "Meeting summary"                   "summarise the meeting notes"                                      "summar"
run_test "professional" "Quarterly report"                  "write a report on our Q1 sales"                                   "report"
run_test "professional" "Cover letter"                      "write a cover letter for a software engineer job"                 "cover letter"
run_test "professional" "Job description"                   "write a job description for a product manager"                    "job description"
run_test "professional" "Performance review"                "write a performance review for my employee"                       "review"
run_test "professional" "Project proposal"                  "write a project proposal for a new mobile app"                    "proposal"
run_test "professional" "Press release"                     "write a press release about our product launch"                   "press release"
run_test "professional" "Executive summary"                 "write an executive summary of our business plan"                  "summar"
run_test "professional" "LinkedIn bio"                      "write a LinkedIn bio for a marketing manager"                     "linkedin"
run_test "professional" "Presentation outline"              "create a presentation about our company strategy"                 "presentation"
run_test "professional" "Feedback for colleague"            "write feedback for a colleague who missed a deadline"             "feedback"

# ─── Research: science & technology ──────────────────────────────────────────
run_test "research" "Broad science topic"                   "explain climate change"                                           "climate"
run_test "research" "Medical concept"                       "explain how vaccines work"                                        "vaccine"
run_test "research" "Physics"                               "explain quantum entanglement"                                     "quantum"
run_test "research" "Biology"                               "explain how DNA replication works"                                "dna"
run_test "research" "Space"                                 "tell me about black holes"                                        "black hole"
run_test "research" "AI concept"                            "explain how large language models work"                           "language model"
run_test "research" "Framework comparison"                  "compare React and Vue"                                            "react"
run_test "research" "Cloud comparison"                      "compare AWS and Google Cloud"                                     "aws"
run_test "research" "Database comparison"                   "compare SQL and NoSQL databases"                                  "sql"

# ─── Research: history & social ──────────────────────────────────────────────
run_test "research" "History overview"                      "tell me about the French Revolution"                              "french revolution"
run_test "research" "Biography"                             "tell me about Nikola Tesla"                                       "tesla"
run_test "research" "Economic concept"                      "explain inflation"                                                "inflation"
run_test "research" "Philosophy"                            "explain the trolley problem"                                      "trolley"
run_test "research" "How-to explanation"                    "explain machine learning"                                         "machine learning"
run_test "research" "Legal concept"                         "explain what copyright means"                                     "copyright"
run_test "research" "Psychology concept"                    "explain cognitive bias"                                           "bias"

# ─── Edge cases ──────────────────────────────────────────────────────────────
# Goal: no hallucinated intent, no degradation, conditions honoured.

run_test "edge" "Already fully specific"   "write a 200-word product description for noise-cancelling headphones targeting remote workers"  "product description"
run_test "edge" "One-word prompt"          "summarise"                                                                        "summar"
run_test "edge" "Two-word prompt"          "explain briefly"                                                                  "explain"
run_test "edge" "Conditions embedded"      "write a blog post about coffee improve prompt keep it under 500 words and casual tone"  "blog"
run_test "edge" "Non-English (Spanish)"    "escribir un poema sobre el mar"                                                   "poema"
run_test "edge" "Non-English (French)"     "écrire une histoire courte sur un chat perdu"                                     "histoire"
run_test "edge" "Non-English (German)"     "schreibe einen Aufsatz über Klimawandel"                                          "klimawandel"
run_test "edge" "Instruction + question"   "what is the best way to learn a new language"                                     "language"
run_test "edge" "Imperative vs question"   "how do I start a business"                                                        "business"
run_test "edge" "Casual phrasing"          "make my writing better"                                                           "writ"
run_test "edge" "Redundant filler words"   "can you please help me write an email to thank someone"                           "email"
run_test "edge" "Contradictory specifics"  "write a very long tweet under 280 characters about productivity"                  "tweet"
run_test "edge" "Audience specified"       "explain blockchain to a 10 year old"                                              "blockchain"
run_test "edge" "Format specified"         "write a bullet point list of tips for public speaking"                            "bullet"
run_test "edge" "Persona prompt"           "pretend you are Shakespeare and write about modern technology"                    "shakespeare"

# ─── Summary ─────────────────────────────────────────────────────────────────
sep
echo
echo "=== Results: $PASS/$TOTAL intent checks passed, $WARN warnings, $FAIL failures ==="
echo
echo "Scoring rubric for manual review:"
echo "  PASS  — specificity improved, meaning preserved"
echo "  WARN  — specificity improved but meaning drifted OR no specificity gain"
echo "  FAIL  — meaning changed significantly, output worse than input, or no output"
echo
echo "Key questions for each output:"
echo "  1. Does the improved prompt still ask for the same thing as the original?"
echo "  2. Did it add useful specificity (format, audience, constraints, scope)?"
echo "  3. Did it invent constraints the user never implied?"
echo "  4. Is each of the 3 alternatives meaningfully different?"
