# Supabase mailbox: setup

This lets the phone reach the shop PC from any network, with no server of
your own. The phone and the PC leave each other **encrypted** messages in a
small Supabase database. Supabase only ever sees scrambled text; the key to
read it never leaves the PC and the phone.

The free plan is enough for a few shops.

## 1. Create the project (about 3 minutes)

1. Go to <https://supabase.com> and create an account.
2. Click **New project**. Choose a name (for example `phone-store`), a
   database password (write it down, you will not need it in the app), and the
   region closest to Algeria (Europe is fine).
3. Wait until the project says it is ready.

## 2. Install the mailbox

1. In the left menu click **SQL Editor**, then **New query**.
2. Open [schema.sql](schema.sql), copy everything, paste it into the editor.
3. Click **Run**. You should see "Success. No rows returned".
   If it complains about `pg_cron`, open **Database > Extensions**, switch on
   `pg_cron`, and run the file again. Running it twice is harmless.

## 3. Copy the two public values

1. Open **Project Settings > API** (or **Data API**).
2. Copy the **Project URL** (looks like `https://abcd1234.supabase.co`).
3. Copy the **anon public** key (a long text starting with `eyJ`).
4. Put both in `app.config.json` of the app:

```json
{
  "remote": {
    "url": "https://abcd1234.supabase.co",
    "anonKey": "eyJ..."
  }
}
```

These two values are public by design. They can only call the five `mb_*`
functions. **Never** put the `service_role` key in the app or in the repo.

## 4. See the shops and block one

- **Table Editor > shops** lists every shop PC that has used outside access:
  its name, when it was first and last seen.
- To block a shop, tick **blocked** on its row and save. Within a minute that
  PC shows "access blocked" and outside access stops. Local (shop Wi-Fi) use
  is not affected. Untick to allow it again.
- **Table Editor > mailbox_messages** only ever shows scrambled text. Rows
  vanish once delivered, and anything left is deleted after 3 days.

## Notes

- A shop's mailbox name is a secret. It is stored only in the PC and the
  paired phone. Do not paste it into chats or logs.
- At most 200 new shops can register per hour, to stop abuse of the free plan.
- If you ever change `schema.sql`, run the new version in the SQL editor.
