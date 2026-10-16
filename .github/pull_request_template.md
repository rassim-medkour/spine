<!--
Sections depend on the change tier (spine writes it to .spine/<run>/tree.json):
- leaf: TL;DR, What changed, How it was checked, How to test
- branch: the leaf sections plus The problem, with an example; Decisions to check; Not verified
- trunk: every section, with Risk and reading map first
Delete the sections your tier does not need, but never delete "Not verified" when it has content.
A spine run can generate this body instead: node <plugin root>/scripts/pr-body.js --run .spine/<run>
-->

## Risk and reading map

<!-- trunk only: the four review-knob answers, then what to read yourself with minutes -->

## TL;DR

<!-- at most 5 lines -->

## The problem, with an example

<!-- branch and trunk: a before and an after -->

## The design decision that shaped everything

<!-- trunk: the spec decision and any owner-resolved disagreement -->

## What changed

| Area | Files | Lines | Tier | What |
|---|---|---|---|---|

## Rollout / switch order

<!-- trunk: flag name or revert steps, and the order to switch things on -->

## Decisions to check

<!-- open disagreements, devil's advocate objections, spec assumptions -->

## How it was checked

<!-- reviewers, findings fixed, verification rounds, proof present -->

## Not verified

<!-- proof gaps, claims with only unverified evidence, skipped checks -->

## How to test

<!-- exact commands -->
