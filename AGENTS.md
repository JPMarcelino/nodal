# Working agreement

## Always make changes live on GitHub

Code changes are not finished while they exist only in the local checkout or on a dev server.

After making changes:

1. Run the relevant checks (`npm run typecheck`, `npm test`, `npm run build`).
2. Commit the changes to `main` with a clear message.
3. Push to `origin` (`git push origin main`).
4. Publish the web app with `npm run deploy:web` when the change affects the app or UI, then share the live link: <https://jpmarcelino.github.io/nodal/>.

Only leave work local when the user explicitly asks for that.
