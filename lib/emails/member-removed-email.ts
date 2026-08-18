import "server-only";

export interface MemberRemovedEmailParams {
  organizationName: string;
}

/**
 * Renders the HTML body for the "you were removed from an organization"
 * notification, sent via Resend (lib/resend.ts) from app/actions/org.ts's
 * removeMember. Mirrors the visual style of invite-email.ts/
 * confirmation.html for a consistent brand feel -- same reasoning as
 * invite-email.ts for why this is a plain TS template rather than a
 * Supabase Auth email template: being removed from an org isn't an auth
 * event, it's this app's own business logic.
 *
 * No link/button here on purpose -- there's nothing actionable to send the
 * recipient to (they no longer have access), unlike the invite email.
 *
 * organizationName is owner-supplied (organizations.name) and interpolated
 * into HTML, so it's escaped -- same reasoning as invite-email.ts.
 */
export function renderMemberRemovedEmail({ organizationName }: MemberRemovedEmailParams): string {
  const safeOrgName = escapeHtml(organizationName);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>You were removed from ${safeOrgName}</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="margin:0; font-size:20px; line-height:28px; color:#18181b;">You were removed from ${safeOrgName}</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 32px 32px;">
                <p style="margin:0; font-size:14px; line-height:22px; color:#52525b;">
                  You no longer have access to <strong>${safeOrgName}</strong>'s workspace, including its notes and
                  billing. If you think this was a mistake, contact the workspace owner directly.
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
