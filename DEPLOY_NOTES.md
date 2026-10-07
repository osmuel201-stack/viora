# PureGlow Solutions — Render + Supabase + Paystack + WhatsApp

## What this version does

- Removes customer email from the website completely.
- Sign up uses **full name + Ghana phone number + password**.
- Sign in uses **phone number + password**.
- Checkout uses **name + phone + collection/delivery details**.
- Paystack still works. Paystack requires an email field internally, so the server generates a technical placeholder email; the customer never enters or sees an email address. citeturn0search0turn0search3
- After successful payment, the customer sees the full order details and taps **Open WhatsApp & Send Order**.
- WhatsApp opens with the order message already written. The customer reviews it and taps **Send** to send it to **0597601733**.
- The WhatsApp message includes customer name, phone, every ordered item, quantity, amount paid, payment reference, and collection/delivery location.
- **Floor Cleaner — 5L** is now **By Order**. Clicking it opens an order form for name, phone, quantity and collection/delivery details, then opens WhatsApp. No payment is taken for that item because the price must be confirmed by the owner.
- The same collection/delivery details are used for every normal paid order.

## 1. Supabase

Open your Supabase project → **SQL Editor** → New query.

Run the complete file:

`supabase/schema.sql`

If your existing database was created from the older email-based version, the final migration statements in this file make the old email fields optional. The new application does not use them.

## 2. Render environment variables

In Render, open your web service → **Environment**.

Add:

- `PAYSTACK_SECRET_KEY` = your Paystack secret key
- `AUTH_SESSION_SECRET` = a long random secret string
- `SUPABASE_URL` = your Supabase project URL
- `SUPABASE_SERVICE_ROLE_KEY` = your Supabase service-role key

Do **not** add the old `BREVO_API_KEY`, `EMAIL_FROM`, `EMAIL_FROM_NAME`, or `BUSINESS_EMAIL` variables. They are no longer used.

Render provides environment variables to the running service, and you can save them and redeploy from the Environment page. citeturn0search9

## 3. Deploy to Render

Push this project to GitHub.

Then in Render:

1. **New → Web Service**
2. Connect the GitHub repository.
3. Runtime: **Node**
4. Build Command: `npm install`
5. Start Command: `npm start`
6. Choose your desired plan.
7. Add the four environment variables above.
8. Deploy.

The supplied `render.yaml` already contains the Node runtime, `npm install`, and `npm start` configuration. Render supports `npm start` as a Node start command. citeturn0search1turn0search2

## 4. Paystack webhook

In Paystack Dashboard → Settings → API Keys & Webhooks, set:

`https://YOUR-RENDER-DOMAIN.onrender.com/api/payments/webhook`

The webhook verifies the Paystack signature and records successful orders in Supabase.

## 5. Test these flows

### Account
- Create account with name + phone + password.
- Log out.
- Sign in with the same phone + password.
- Confirm the checkout automatically fills name and phone.

### Normal product
- Add dishwashing liquid/fabric softener/bleach to cart.
- Choose **Collection** or **Cape Coast delivery**.
- For delivery, enter area + address.
- Pay with Paystack.
- Wait for “Payment Confirmed”.
- Tap **Open WhatsApp & Send Order**.
- WhatsApp should open with the complete order.
- Tap **Send**.

### Floor Cleaner
- Click Floor Cleaner.
- It should say **By Order**.
- Enter name, phone and quantity.
- Choose collection or delivery.
- Tap **Continue to WhatsApp**.
- WhatsApp opens with the complete request.
- Tap **Send**.

## Important

Paystack's current transaction initialization API requires an email field, so removing email from the customer-facing website does **not** mean the API request can omit it. This version handles that requirement invisibly on the server with a technical placeholder. citeturn0search0turn0search3
