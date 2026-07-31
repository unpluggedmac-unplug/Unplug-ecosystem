// The one place Unplug's banking details live.
//
// They were previously inline in routes/payments.js. Edition downloads also
// need to show them, and bank details copied into a second file is exactly the
// kind of thing that gets updated in one place and not the other — with money
// going to a stale account as the result.
function eftInstructions(reference, note) {
  return {
    bank: 'FNB / RMB',
    accountName: 'Unplug',
    accountType: 'First Business Zero Account',
    accountNumber: '63092416833',
    branchCode: '250655',
    reference,
    note: note || 'Make a standard bank EFT to the account above and use this exact reference so we can match your payment. Branch code 250655 is FNB’s universal code, so it works for EFTs from any bank. Your payment is confirmed manually by an admin once it reflects.',
  };
}

module.exports = { eftInstructions };
