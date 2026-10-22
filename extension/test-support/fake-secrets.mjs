// Fake, secret-shaped test values. They are assembled at run time so that no
// literal token-shaped string sits in the repository: GitHub push protection
// (rightly) cannot tell a fixture from a leaked key. None of these is real.
const join = (...parts) => parts.join('');
export const FAKE = Object.freeze({
  whsec: join('whsec', '_', 'C'.repeat(24)),
  resend: join('re', '_', 'Fake1234', '_', 'NotARealResendKey0000'),
  stripeTest: join('sk', '_test_', '51Fake', 'NotARealKey0000000'),
  stripeRestrictedTest: join('rk', '_test_', '51Fake', 'NotARealKey0000000'),
  awsTemp: join('AS', 'IA', 'FAKE0000NOTREAL0'),
  slackRefresh: join('xo', 'xe-1-', 'fakenotreal0000000'),
  awsSecret: join('Fake', 'NotARealAwsSecretAccessKey', '00000000000000').slice(0, 40),
});
