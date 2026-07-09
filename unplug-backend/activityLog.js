// TEMPORARY — confirms which database this backend is actually talking
// to. Safe to delete once the mismatch question is resolved.
router.get('/db-check', async (req, res, next) => {
  try {
    const result = await pool.query('SELECT current_database(), current_schema(), current_user;');
    res.json(result.rows[0]);
  } catch (err) {
    next(err);
  }
});
