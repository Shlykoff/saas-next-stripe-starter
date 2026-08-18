import "server-only";

export interface RoleChangedEmailParams {
  organizationName: string;
  newRole: string;
}

/**
 * Renders the HTML body for the "your role changed" notification, sent via
 * Resend (lib/resend.ts) from app/actions/org.ts's changeMemberRole. Same
 * visual style as invite-email.ts/member-removed-email.ts for a consistent
 * brand feel; no link/button, same reasoning as member-removed-email.ts --
 * there's nothing new to act on, this is purely informational.
 *
 * organizationName/newRole are owner-supplied (organizations.name,
 * organization_members.role) and interpolated into HTML, so both are
 * escaped -- same reasoning as the other transactional emails in this app.
 */
export function renderRoleChangedEmail({ organizationName, newRole }: RoleChangedEmailParams): string {
  const safeOrgName = escapeHtml(organizationName);
  const safeRole = escapeHtml(newRole);

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>Your role in ${safeOrgName} changed</title>
  </head>
  <body style="margin:0; padding:0; background-color:#f4f4f5; font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="background-color:#f4f4f5; padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" width="480" cellpadding="0" cellspacing="0" style="max-width:480px; width:100%; background-color:#ffffff; border-radius:12px; overflow:hidden; border:1px solid #e4e4e7;">
            <tr>
              <td style="padding:32px 32px 8px 32px;">
                <h1 style="margin:0; font-size:20px; line-height:28px; color:#18181b;">Your role in ${safeOrgName} changed</h1>
              </td>
            </tr>
            <tr>
              <td style="padding:8px 32px 32px 32px;">
                <p style="margin:0; font-size:14px; line-height:22px; color:#52525b;">
                  You're now a${safeRole === "owner" ? "n" : ""} <strong>${safeRole}</strong> in <strong>${safeOrgName}</strong>.
                  If you weren't expecting this change, contact the workspace owner directly.
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
