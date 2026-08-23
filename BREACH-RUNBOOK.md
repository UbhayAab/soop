# DPDP Breach Runbook

## Triggers
- Unauthorised access to personal data confirmed or suspected
- Data breach notification received from Supabase, edge function, or external source
- Internal audit revealing policy violation or anomalous data exposure
- User report of compromised account or missing data

## Immediate Steps (0–24 hours)

1. **Contain the breach**
   - Revoke compromised tokens / API keys immediately
   - Disable affected service accounts or embed hosts
   - Arrest further data exfiltration: toggle `disable_signup` off via `scripts/auth-config.mjs --closed-signup` if the vector is signup-related
   - Preserve logs: do not purge audit_log, embed_tickets, or message tables

2. **Assess scope**
   - Run `public.retention_sweep()` to identify how far the breach extends
   - Query `public.audit_log` for recent `retention_sweep` events and `embed_sweep_tickets`
   - Identify affected users: `select id, email, created_at from auth.users where ...`
   - Determine data categories exposed: email, display name, message history, media attachments

3. **Notify DPDP authorities** (if required)
   - Personal data breach must be reported to the Indian DPDP Authority within 72 hours if it is likely to risk the rights of data principals
   - Document the nature of the breach, categories of affected data, number of data principals affected, and measures taken

4. **Notify affected data principals**
   - Send direct notification to affected users via email or in-app
   - Include: what data was involved, how it happened, what you are doing about it, and rights available (access, correction, erasure, grievance)

## 30–90 Days Follow-Up

5. **Root cause analysis**
   - Review which control failed: RLS policy, secret management, Edge Function validation, cron job
   - Update policies, rotate secrets, add guards to prevent recurrence

6. **Record in audit_log**
   ```sql
   insert into public.audit_log (kind, detail, created_at)
   values ('breach_event',
     jsonb_build_object(
       'trigger', '<cause>',
       'scope', '<affected_categories>',
       'users_affected', <count>,
       'notified_at', now()
     ),
     now());
   ```

7. **Review retention policy**
   - Re-examine `public.retention_sweep()` parameters (currently 90 days messages, 30 days join requests, 365 days workspace last_seen)
   - Adjust intervals if the breach reveals data was kept longer than necessary

## Post-Incident Checklist

- [ ] Breach contained and exfiltration stopped
- [ ] Scope assessed and documented
- [ ] DPDP Authority notified (within 72 hours if required)
- [ ] Affected data principals notified
- [ ] Root cause documented and mitigated
- [ ] Audit log updated with breach event
- [ ] Retention policy reviewed and adjusted
- [ ] Secrets rotated and access controls revised
- [ ] Run `public.retention_sweep()` to clean up any residual stale data
- [ ] Team retrospective and process update