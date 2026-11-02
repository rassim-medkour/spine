# Product context: Shopfront

## Users

- Shopper: buys items on the web storefront.
- Support agent: refunds and edits orders.

## Goals

- Checkout completes in under three steps.
- A shopper never loses a cart.

## Glossary

- Cart: the items a shopper has chosen and not yet paid for.
- Order: a paid cart.

## Invariants

- An order total is never negative.
- A refunded order keeps its original number.
- A paid order cannot be edited by the shopper.

## Key flows

### Checkout

weight: critical
paths: src/checkout/**, src/pay*.js

1. Open the cart.
2. Enter the delivery address.
3. Pay and see the confirmation page.

### Refund

weight: important
paths: src/refund/**

1. Open the order as support.
2. Press refund.

## UX principles

- Errors say what to do next, never a code.
- Every form field has a visible label.
