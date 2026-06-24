// ---------------------------------------------------------------------------
// TotpEnrollmentWizard — the TOTP enrollment panel (QR + manual secret + code).
//
// PRESENTATIONAL + props-driven on purpose (design § 6.4). It makes NO
// auth-session assumption and does no fetching itself, so the SAME component
// mounts in two containers:
//   - /account (AccountPage): the container calls authProvider.setUpTotp() to
//     get { secret, otpauthUri } and, on submit, verifyTotpSetup(code).
//   - LoginPage (the rare forced-setup-at-login step, § 6.5): the container
//     feeds the details from the sign-in nextStep and verifies via confirmSignIn.
//     Rendering inline here — NOT redirecting to /account — avoids the
//     mid-challenge redirect loop (a user at this step has no session yet).
//
// SECURITY: the otpauth URI embeds the TOTP shared secret. The QR is rendered
// client-side (qrcode.react → inline SVG, no network), so the secret never
// leaves the browser.
// ---------------------------------------------------------------------------

import { useState } from 'react';
import type { FormEvent } from 'react';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  IconButton,
  Stack,
  TextField,
  Tooltip,
  Typography,
} from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import CheckIcon from '@mui/icons-material/Check';
import { QRCodeSVG } from 'qrcode.react';
import { FormattedMessage, useIntl } from 'react-intl';

export interface TotpEnrollmentWizardProps {
  /** Base32 shared secret for manual entry. */
  readonly secret: string;
  /** `otpauth://…` provisioning URI rendered as the QR code. */
  readonly otpauthUri: string;
  /** Called with the 6-digit code when the user submits. */
  readonly onVerify: (code: string) => void;
  /** True while verification is in flight — disables the form. */
  readonly pending?: boolean;
  /** Verification error to surface inline, or null. */
  readonly error?: string | null;
  /** Optional cancel handler — renders a Cancel button when provided. */
  readonly onCancel?: () => void;
}

/** A TOTP code is exactly 6 digits. */
const CODE_LENGTH = 6;

export function TotpEnrollmentWizard({
  secret,
  otpauthUri,
  onVerify,
  pending = false,
  error = null,
  onCancel,
}: TotpEnrollmentWizardProps): React.JSX.Element {
  const intl = useIntl();
  const [code, setCode] = useState('');
  const [copied, setCopied] = useState(false);

  const handleCopy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(secret);
      setCopied(true);
      // Revert the "copied" affordance shortly after; failure is silent (the
      // secret is also visible on-screen for manual entry).
      window.setTimeout(() => setCopied(false), 2000);
    } catch {
      /* clipboard unavailable (e.g. insecure context) — the secret is shown */
    }
  };

  const handleSubmit = (e: FormEvent<HTMLFormElement>): void => {
    e.preventDefault();
    if (code.length !== CODE_LENGTH || pending) return;
    onVerify(code);
  };

  return (
    <form onSubmit={handleSubmit} noValidate>
      <Stack spacing={2}>
        <Typography variant="body1">
          <FormattedMessage id="mfa.enrollScanInstruction" />
        </Typography>

        {/* QR — inline SVG, no network. role=img + title for screen readers. */}
        <Box sx={{ display: 'flex', justifyContent: 'center', py: 1 }}>
          <QRCodeSVG
            value={otpauthUri}
            size={180}
            title={intl.formatMessage({ id: 'mfa.qrTitle' })}
          />
        </Box>

        {/* Manual-entry fallback. */}
        <Box>
          <Typography variant="body2" color="text.secondary" sx={{ mb: 0.5 }}>
            <FormattedMessage id="mfa.enrollManualLabel" />
          </Typography>
          <Stack direction="row" spacing={1} alignItems="center">
            <Typography
              component="code"
              sx={{
                fontFamily: 'monospace',
                fontSize: 14,
                letterSpacing: 1,
                wordBreak: 'break-all',
                bgcolor: 'action.hover',
                px: 1,
                py: 0.5,
                borderRadius: 1,
              }}
            >
              {secret}
            </Typography>
            <Tooltip
              title={intl.formatMessage({ id: copied ? 'mfa.enrollCopied' : 'mfa.enrollCopySecret' })}
            >
              <IconButton
                size="small"
                onClick={() => void handleCopy()}
                aria-label={intl.formatMessage({ id: 'mfa.enrollCopySecret' })}
              >
                {copied ? <CheckIcon fontSize="small" color="success" /> : <ContentCopyIcon fontSize="small" />}
              </IconButton>
            </Tooltip>
          </Stack>
        </Box>

        {error && (
          <Alert severity="error" role="alert">
            {error}
          </Alert>
        )}

        <TextField
          label={intl.formatMessage({ id: 'mfa.enrollCodeLabel' })}
          value={code}
          onChange={(e) => setCode(e.target.value.replace(/\D/g, '').slice(0, CODE_LENGTH))}
          disabled={pending}
          required
          fullWidth
          // Freshly-mounted enrollment step; focusing the code field is the
          // expected next action. Same accepted trade-off as LoginPage's MFA field.
          // eslint-disable-next-line jsx-a11y/no-autofocus
          autoFocus
          slotProps={{
            htmlInput: {
              inputMode: 'numeric',
              pattern: '[0-9]*',
              autoComplete: 'one-time-code',
              maxLength: CODE_LENGTH,
              'aria-label': intl.formatMessage({ id: 'mfa.enrollCodeLabel' }),
            },
          }}
        />

        <Stack direction="row" spacing={1} justifyContent="flex-end">
          {onCancel && (
            <Button onClick={onCancel} disabled={pending}>
              <FormattedMessage id="mfa.enrollCancel" />
            </Button>
          )}
          <Button
            type="submit"
            variant="contained"
            disabled={code.length !== CODE_LENGTH || pending}
            startIcon={pending ? <CircularProgress size={16} color="inherit" /> : undefined}
          >
            <FormattedMessage id={pending ? 'mfa.enrollVerifying' : 'mfa.enrollVerify'} />
          </Button>
        </Stack>
      </Stack>
    </form>
  );
}
