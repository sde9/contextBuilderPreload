# Bookings table
Each booking row holds a customer id, a costume id and a hire window. There is a
status column with values pending, confirmed, collected and returned.

## Deposits
Deposits are stored against the booking row, not against the customer. The deposit
amount is a fixed 30 percent of the hire price.

## Known problems
There is no field for a late fee, so late returns are tracked outside the system in a
spreadsheet. There is also no audit of who approved a refund.
