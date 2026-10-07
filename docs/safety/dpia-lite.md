# Data protection impact assessment notes

**Status:** partial

This is a lightweight engineering risk note, not legal advice, a legal basis, or a compliance
assessment. I have not decided whether the processing requires a formal assessment.

## Processing and purpose

The app supports stock management, billing, customer credit, analytics, conversation continuity and
document generation for an invited shop owner. It stores business and customer records in PostgreSQL,
mirrors conversation entries for session recovery, sends text context to Anthropic, and sends voice
audio to OpenAI for transcription when the owner uses voice. See the [data inventory](../privacy/data-inventory.md).

## People and data

People whose data may appear include the shop owner, customers named in bills or khata records, and
people mentioned in owner messages. Data may include Telegram identifiers, product and shop data,
customer names and phone numbers, financial amounts, free-text notes, conversation text, generated
documents and usage metadata. Provider-side retention was not verified.

## Risks and measures

| Risk | Current measure | Status |
|---|---|---|
| Another Telegram user reaches a shop | Invite redemption binds the owner in a private chat; legacy stores and group chats fail closed. | implemented |
| One shop exports another shop's rows | Repository scopes export rows by store; transcript ownership ambiguity fails closed. | implemented |
| Sensitive action executes from model wording alone | Owner-bound callback, short opaque database ID, 10-minute expiry, atomic one-use claim. | implemented |
| Customer identifiers remain in conversation history after pseudonymisation | Preview tells the owner that existing transcript mentions are not changed; no transcript scrub is implemented. | partial |
| Local files or transcripts persist longer than intended | Configurable inactivity cleanup; new indexed artifacts use authenticated owner activity, and exports are deleted after a delivery attempt. Historical unindexed files expire by filesystem modification time because no safe store backfill exists. | partial |
| Data remains with Telegram or AI providers | No app control is claimed. Provider retention settings and contractual terms remain unverified. | not done |
| Store deletion conflicts with accounting records | Store erasure has no implementation pending legal review. | not done |

## Proposed defaults and decisions needed

- **Proposed retention default:** transcript and new indexed artifact cleanup after 30 days from
  last authenticated owner activity. The application default is configurable; historical
  unindexed artifacts expire by filesystem modification time until they age out. The period is not
  a legal determination.
- **Proposed erasure approach:** pseudonymise customer account and linked bill identifiers, clear
  direct phone, notes and payment references, and retain monetary/accounting rows. This has not had
  legal review and is not represented as a legal determination.
- **Store erasure:** not done. Legal review must decide how bills, ledgers, audit records, backups,
  and provider-held data should be handled before a store-erasure path is considered.
- **Owner contact:** `PRIVACY_CONTACT` is configurable. If it is unset, the bot says to ask whoever
  gave the owner their invite. I do not invent a contact or legal basis here.

## Follow-up

The project maintainer should obtain legal review of retention and financial-record treatment,
verify provider and deployment retention settings, and decide whether a formal impact assessment is
needed. No conclusion about applicable law is made here.
