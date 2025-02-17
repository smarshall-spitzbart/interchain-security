---
sidebar_position: 1
title: ADRs
---

# Architecture Decision Records (ADR)

This is a location to record all high-level architecture decisions in the Interchain Security project.

You can read more about the ADR concept in this [blog post](https://product.reverb.com/documenting-architecture-decisions-the-reverb-way-a3563bb24bd0#.78xhdix6t).

An ADR should provide:

- Context on the relevant goals and the current state
- Proposed changes to achieve the goals
- Summary of pros and cons
- References
- Changelog

Note the distinction between an ADR and a spec. The ADR provides the context, intuition, reasoning, and
justification for a change in architecture, or for the architecture of something
new. The spec is much more compressed and streamlined summary of everything as
it is or should be.

If recorded decisions turned out to be lacking, convene a discussion, record the new decisions here, and then modify the code to match.

Note the context/background should be written in the present tense.

To suggest an ADR, please make use of the [ADR template](./adr-template.md) provided.

## Table of Contents

| ADR \# | Description | Status |
| ------ | ----------- | ------ |
| [001](./adr-001-key-assignment.md) | Consumer chain key assignment | Accepted, Implemented |
| [002](./adr-002-throttle.md) | Jail Throttling | Accepted, Implemented |
| [003](./adr-003-equivocation-gov-proposal.md) | Equivocation governance proposal | Accepted, Implemented |
| [004](./adr-004-denom-dos-fixes) | Denom DOS fixes | Accepted, Implemented |
| [005](./adr-005-cryptographic-equivocation-verification.md) | Cryptographic verification of equivocation evidence | Accepted, In-progress |
| [007](./adr-007-pause-unbonding-on-eqv-prop.md) | Pause validator unbonding during equivocation proposal | Proposed |
| [008](./adr-008-throttle-retries.md) | Throttle with retries | Accepted, In-progress |
| [009](./adr-009-soft-opt-out.md) | Soft Opt-out | Accepted, Implemented |
| [009](./adr-010-standalone-changeover.md) | Standalone to Consumer Changeover | Accepted, Implemented |
