# Incident runbook

**Status:** partial

This runbook covers practical response steps for the current bot. It does not replace the operator's
hosting, provider or legal incident process. Keep secrets out of tickets, transcripts and this file.

## Suspected credential exposure

1. The operator should stop or restrict the affected bot deployment if an exposed credential could
   still be used. Avoid printing the credential while checking configuration.
2. Rotate `TELEGRAM_BOT_TOKEN` with Telegram's bot management flow and replace the deployed value.
   Rotate `ANTHROPIC_API_KEY` in its provider console and replace the deployed value. Rotate any
   `OPENAI_API_KEY` too if voice credentials may have been exposed.
3. Restart the deployment and verify the new process works without echoing credential values.
4. Confirm the old credentials are rejected through the provider's own controls. Record completion
   time and responsible role, not secret contents.
5. Review deployment logs and access history available to the operator. Do not copy full logs into
   a public issue; redact message text, IDs and tokens first.

The Telegram bot token and Anthropic API key reached deployment logs earlier in this project's
history. Rotation remains an operator task. This runbook does not assert that they have been rotated.

## Suspected cross-store access or unauthorized action

1. Pause the affected bot instance if the issue is ongoing; preserve the relevant update ID, store
   ID and timestamp in restricted operator notes without copying message text or customer data.
2. Check owner binding, pending-action status and audit metadata using the normal access-controlled
   database procedure. Do not run ad hoc writes against production.
3. Determine whether stock, bills, khata, exported files or transcripts changed. Use the existing
   ledger and bill history to reconcile; do not delete accounting rows as incident cleanup.
4. Rotate/revoke affected invite codes or credentials as needed, then restore service only after the
   unauthorized path is closed and a regression test covers it.

## Suspected data disclosure

1. Limit further delivery and access. Preserve a minimal timeline and affected data categories.
2. Identify whether the data left through Telegram, Anthropic, OpenAI, a generated artifact, logs or
   a cross-store query. Provider-side deletion is not assumed; check provider controls separately.
3. Contact the affected owner through the configured `PRIVACY_CONTACT` if verified. If unset, the
   bot's product copy directs them to whoever issued the invite. Do not invent a contact address.
4. Ask the operator/legal reviewer to decide any required notifications. This runbook makes no
   legal notification determination.

## Record and recovery

Keep only the minimum incident facts needed for investigation, with access limited to the operator.
Record actions taken, tests added, and unresolved risks in the private operational record. Do not
put credentials, owner messages, customer names or phone numbers in the repository's public docs.
