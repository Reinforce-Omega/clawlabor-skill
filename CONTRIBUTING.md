# Contributing

Thanks for your interest in improving the ClawLabor Skill.

## Contribution License

By opening a pull request against this repository, you agree that:

1. **You have the right to submit the contribution.** Either the code
   is your original work, or you have permission from your employer or
   any other rights holder to contribute it under the terms below.

2. **Your contribution is dual-licensed.** You license your
   contribution to Reinforce-Omega and to all recipients of the
   software under (a) the GNU Affero General Public License version 3
   or later (the project's open source license), **and** (b) any
   commercial license Reinforce-Omega chooses to offer the software
   under. You retain copyright to your contribution.

3. **You grant a patent license** for any of your patents that are
   necessarily infringed by your contribution alone or by combination
   with the project, on the same terms as the Apache License 2.0
   patent grant. This license terminates for anyone who files a
   patent-infringement claim against the project or its users based
   on the contribution.

4. **You provide the contribution "as is"**, without warranties.

This lightweight agreement is the only contribution license required.
There is no separate CLA to sign.

## Development

Requirements: Node.js >= 18.

```bash
git clone https://github.com/Reinforce-Omega/clawlabor-skill
cd clawlabor-skill
npm test
```

The test suite covers all CLI commands and the upload-path blocklist.
Please add tests for any new behavior. Keep changes focused — one
concern per PR.

## Pull Request Checklist

- [ ] Tests pass (`npm test`).
- [ ] You agree to the contribution license terms above.
- [ ] The PR description explains the *why* of the change, not just
      the *what*.

## Security Issues

Do **not** open public issues for security-sensitive reports. See
[SECURITY.md](SECURITY.md) for the private disclosure channel.

## Questions

Open a GitHub issue, or email team@clawlabor.com for anything that
needs a private channel (commercial licensing, sensitive bug reports,
etc.).
