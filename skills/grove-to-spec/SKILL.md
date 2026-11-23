---
name: grove-to-spec
description: Publish the current conversation as an implementation spec in the configured issue tracker, then run spec self-review.
---

Turn the current conversation and codebase context into one implementation-ready spec. Do not restart discovery as an interview. Draft from the known context, then use the shared spec review workflow to revise it and determine readiness.

Follow the [issue tracker instructions](ISSUE-TRACKER.md) to publish one issue per new spec. Use the issue body as the authority for exactly one PR. Give the body a repository identifier and concise feature slug. Tickets are optional work units within that PR.

## Process

1. Explore the repository enough to understand current behaviour, existing test seams, domain vocabulary, and relevant ADRs.

2. Choose the highest existing seam that can verify the observable feature. Add a seam only when no existing one can test the promised behaviour. Make technical testing decisions yourself.

3. Publish the spec issue with `Status: draft`, using the template below. Keep its canonical issue URL for subsequent edits, tickets and the PR.

4. After publishing the draft, discover and read `grove-spec-self-review` by its exact frontmatter name, then follow it against the issue URL in the same turn. That skill owns revision, clarification and the readiness decision. Return the issue URL and final status.

<spec-template>

Issue title: Spec: <feature>

Repository: <repository identifier>
Feature: <slug>
Status: draft

## Problem Statement

The problem from the user's perspective.

## Solution

The smallest complete solution from the user's perspective.

## User Stories

A numbered list covering the promised user-visible behaviour. Include only stories needed to define the feature and its important edge cases.

1. As an <actor>, I want <feature>, so that <benefit>.

## Delivery Boundary

This spec is implemented and reviewed as one PR. It may be decomposed into multiple tickets on the same branch when that makes execution easier.

## Implementation Decisions

Decisions that constrain the implementation, such as changed modules or interfaces, architectural choices, schema changes, API contracts, and specific interactions. Prefer the simplest design that meets the user stories.

Do not include file paths or code snippets that will quickly go stale. If a prototype produced a decision-rich state machine, reducer, schema, or type shape that is more precise than prose, include only that trimmed excerpt and identify it as prototype-derived.

## Testing Decisions

State the observable contracts to test, the highest existing seams used, and relevant prior art in the repository. Test behaviour rather than implementation details.

## Estimated Changed LOC

Estimate implementation size as ranges for product code, tests, and configuration/docs, followed by a total range. Count additions plus deletions against the PR's fixed point; exclude generated files and lockfiles. Note the main assumptions behind the estimate so implementation can report actuals and explain material variance.

## Out of Scope

Name nearby capabilities intentionally excluded from this PR.

## Further Notes

Only context needed to implement or review the spec.

## Tickets

Include this section when there are tickets. Use checkboxes for work tracked in this issue and links for work tracked in separate issues.

</spec-template>
