import "server-only";

export interface InviteEmailParams {
  organizationName: string;
  role: string;
  inviteUrl: string;
}

/**
 * Renders the HTML body for an organization-invite email, sent via Resend
 * (lib/resend.ts) from app/actions/invites.ts's createInvite. Deliberately
 * mirrors the visual style of supabase/templates/confirmation.html (a single
 * white card on a grey background, one heading, one paragraph, one button)
 * for a consistent brand feel across both transactional email sources --
 * this one is a plain TS template string rather than a Supabase Auth email
 * template, because an org invite isn't a Supabase Auth event at all (no
 * token_hash/verifyOtp involved, see the organization_invites migration's
 * own top-of-file comment): it's this app's own business logic, sent
 * directly through Resend.
 *
 * organizationName is owner-supplied (organizations.name) and interpolated
 * into HTML, so it's escaped -- an org named e.g. `<script>...` must never
 * execute in the invitee's mail client.
 */
export function renderInviteEmail({ organizationName, role, inviteUrl }: InviteEmailParams): string {
  const safeOrgName = escapeHtml(organizationName);
  const safeRole = escapeHtml(role);
  const safeUrl = escapeHtml(inviteUrl);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>You're invited to join ${safeOrgName}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="margin:0; font-size:20px; line-height:28px; color:#18181b;">You're invited to join ${safeOrgName}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 24px 32px;">
                <p style="margin:0; font-size:14px; line-height:22px; color:#52525b;">
                  You've been invited to join <strong>${safeOrgName}</strong> as <strong>${safeRole}</strong>.
                  Click the button below to accept. This invite expires in 7 days.
                </p>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px;">
                <a
                  href="${safeUrl}"
                  style="display:inline-block; background-color:#18181b; color:#ffffff; text-decoration:none; font-size:14px; font-weight:600; padding:12px 20px; border-radius:8px;"
                >
                  Accept invite
                </a>
              </td>
            </tr>
            <tr>
              <td style="padding:0 32px 32px 32px; border-top:1px solid #e4e4e7; padding-top:16px;">
                <p style="margin:0; font-size:12px; line-height:18px; color:#a1a1aa;">
                  If the button above doesn't work, copy and paste this link into your browser:
                  <br />
                  <span style="word-break:break-all;">${safeUrl}</span>
                </p>
                <p style="margin:12px 0 0 0; font-size:12px; line-height:18px; color:#a1a1aa;">
                  If you weren't expecting this invite, you can safely ignore this email.
                </p>
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>
`;
}

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}
