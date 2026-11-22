#!/bin/bash
# The recorded test set for the voice helper's wake phrase and sleep word (roamies-voice --bench <dir>).
# ./make-set.sh <dir>  speaks every line below with macOS `say`, in several voices and at two rates, into <dir>/*.wav,
# and writes <dir>/manifest.tsv: file, set, what should happen (wake, sleep or none), the wake phrase and sleep word
# set while it's heard. The helper then mixes in room noise and level changes, and runs each one through the same
# path the mic feeds (the boost, the recogniser, the matcher). Claps are made up by the helper itself (bench.swift).
set -euo pipefail
out="${1:?usage: make-set.sh <dir>}"
mkdir -p "$out"
voices=("Samantha" "Daniel" "Karen" "Moira" "Rishi" "Tessa" "Reed (English (US))" "Shelley (English (US))")
rates=(165 215)
man="$out/manifest.tsv"
: > "$man"
n=0
line() { # set expect wake sleep text
  local set="$1" expect="$2" wake="$3" sleep="$4" text="$5"
  for v in "${voices[@]}"; do
    for r in "${rates[@]}"; do
      n=$((n + 1))
      local f
      f=$(printf '%s-%04d.wav' "$set" "$n")
      # A voice can hang on a line now and then: 30 s at most, and that clip is left out.
      [ -s "$out/$f" ] || perl -e 'alarm 30; exec @ARGV' say -v "$v" -r "$r" --file-format=WAVE --data-format=LEI16@22050 -o "$out/$f" "$text" || { rm -f "$out/$f"; echo "skipped $f ($v)" >&2; continue; }
      printf '%s\t%s\t%s\t%s\t%s\t%s\n' "$f" "$set" "$expect" "$wake" "$sleep" "$text" >> "$man"
    done
  done
}
D="Hey Hydra"; S="Hydra, sleep"
# Positives: what should wake it, or put it to sleep.
line hey_hydra wake "$D" "$S" "Hey Hydra"
line hey_hydra wake "$D" "$S" "Hey Hydra, open Safari."
line hey_hydra wake "$D" "$S" "Hey Hydra, what's on my calendar today?"
line hydra wake "$D" "$S" "Hydra."
line hydra wake "$D" "$S" "Hydra, open Mail."
line hydra wake "$D" "$S" "Hydra, what time is it?"
line custom wake "Okay Computer" "$S" "Okay computer."
line custom wake "Okay Computer" "$S" "Okay computer, play some music."
line goodnight sleep "$D" "Goodnight Hydra" "Goodnight, Hydra."
line goodnight sleep "$D" "Goodnight Hydra" "Good night Hydra."
line three_kill sleep "$D" "3 kill" "Three kill."
line three_kill sleep "$D" "3 kill" "3 kill."
# Negatives: ordinary talk and near words, heard with every phrase above set. None may wake it or put it to sleep.
for t in "I need to hydrate after the run." "My new car is a Hyundai." "Hey there, how are you doing?" \
  "Heather is coming over later." "The hydraulic press is broken again." "Did you water the hydrangeas?" \
  "Hi Harry, nice to meet you." "Let's get some coffee before the meeting." "Good night everyone, see you tomorrow." \
  "I'm going to sleep early tonight." "Hide the remote, please." "We killed three hours at the airport." \
  "Okay, compute the total for me." "Hey, hand me that charger."; do
  line negative none "$D" "$S" "$t"
done
echo "wrote $n clips and $man"
