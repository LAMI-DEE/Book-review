import express from "express";
import bodyParser from "body-parser";
import pg from "pg";
import axios from "axios";

const app = express();
const port = process.env.PORT || 3000;

const db = process.env.DATABASE_URL
  ? new pg.Client({
      connectionString: process.env.DATABASE_URL,
      ssl: {
        rejectUnauthorized: false
      }
    })
:new pg.Client({
  user: "postgres",
  host: "localhost",
  database: "books",
  password: "1234D",
  port: 5432,
});
db.connect();

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static("public"));

app.get("/",async (req,res) => {
  try{
    const result = await db.query("SELECT books.*, reviews.id AS review_id FROM books JOIN reviews ON books.id = reviews.book_id ORDER BY RANDOM() LIMIT 5");
    const books = result.rows;
    res.render("index.ejs",{
      books
    });
  } catch (err){
    console.error(err);
    res.render("index.ejs",{
      books: []
    });
  }
});

app.get("/reviewed", async (req,res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 6;
  const offset = (page - 1) * limit;

  try{
    const countResult = await db.query("SELECT COUNT(DISTINCT book_id) FROM reviews");
    const totalReviewed = parseInt(countResult.rows[0].count);
    const totalPages = Math.ceil(totalReviewed / limit);

    const booksResult = await db.query("SELECT DISTINCT books.*,reviews.updated_at FROM books JOIN reviews ON books.id = reviews.book_id ORDER BY reviews.updated_at DESC LIMIT $1  OFFSET $2",[limit,offset]);
    const books = booksResult.rows

    res.render("reviewed.ejs", {
      books,
      currentPage: page,
      totalPages
    });
  }catch(err){
    console.error("Error fetching reviewed books:", err);
    res.status(500).send("Internal Server Error")
  }
});

app.get("/search", async (req,res) => {
  const searchItem = req.query.q;

  try{
    const response = await axios.get(`https://openlibrary.org/search.json?q=${encodeURIComponent(searchItem)}&limit=20`);
    const data = response.data;

    const booksFromAPI = data.docs.map((doc) => {
      return{
        openlibrary_key: doc.key,
        title: doc.title,
        author: doc.author_name?doc.author_name[0] : "Unknown Author",
        cover_url: doc.cover_i? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "/altcover.jpeg"
      };
    });
    const olKeys = booksFromAPI.map(book => book.openlibrary_key);
    const result = await db.query(
      `SELECT DISTINCT books.openlibrary_key FROM books INNER JOIN reviews ON books.id = reviews.book_id WHERE books.openlibrary_key = ANY($1::text[])`,[olKeys]
    );
    const reviewedKeys = result.rows.map(row => row.openlibrary_key);

    const finalBooks = booksFromAPI.map(book => {
  const isReviewed = reviewedKeys.includes(book.openlibrary_key);
  const reviewUrl = isReviewed
    ? `/review-by-key?key=${book.openlibrary_key}`
    : `/write-review?key=${book.openlibrary_key}`;
  
  return {
    ...book,
    isReviewed,
    reviewUrl
  };
});
    res.render("search.ejs", {books: finalBooks, query: searchItem});
  }catch (error){
    console.error("Search error:", error);
    res.status(500).send("An error occured while searching.");
  }
});

app.get("/review-by-key", async (req,res) => {
  const olKey = req.query.key;
  const result = await db.query("SELECT reviews.*, books.title, books.author, books.cover_url, books.openlibrary_key FROM reviews JOIN books ON reviews.book_id = books.id WHERE books.openlibrary_key = $1",[olKey]);

  if(result.rows.length === 0){
    return res.status(404);
  }
  const reviewData = result.rows[0];

  res.render("read-review.ejs",
    {
      book: reviewData,
      review: reviewData
    }
  )
});

app.get("/write-review", async (req, res) => {
  const bookKey = req.query.key;

  if (!bookKey) return res.status(400).send("Missing key");

  res.render("review-form.ejs", {
    formTitle: "Write Review",
    formAction: `/write-review?key=${bookKey}`,
    rating: "",
    content: "",
    error: null
  });
});

app.post("/write-review", async (req, res) => {
  const olKey = req.query.key;
  const {rating, content} = req.body;

  if(!olKey) return res.status(400).send("Missing Key");

  if(rating < 1 || rating > 5) {
    return res.render("review-form.ejs",{
      formTitle: "Write Review",
      formAction: `/write-review?key=${olKey}`,
      content,
      error: "Rating should be between 1 and 5"
    });
  }
  

  try {
    let result = await db.query("SELECT id FROM books WHERE openlibrary_key = $1", [olKey]);
    let bookId;

    if(result.rows.length === 0){
      const searchResult = await axios.get(`https://openlibrary.org/search.json?q=${encodeURIComponent(olKey)}`);
      const doc = searchResult.data.docs.find(d => d.key === olKey);

      const title = doc?.title || "Unknown Title";
      const author = doc?.author_name?.[0] || "Unknown Author";
      const coverUrl = doc?.cover_i? `https://covers.openlibrary.org/b/id/${doc.cover_i}-M.jpg` : "/altcover.jpeg";

      const insertBook = await db.query("INSERT INTO books (openlibrary_key, title, author, cover_url) VALUES ($1, $2, $3, $4) RETURNING id",[olKey, title, author , coverUrl]);
      bookId = insertBook.rows[0].id;
    }else {
      bookId= result.rows[0].id;
    }

    await db.query("INSERT INTO reviews (book_id, rating, content) VALUES ($1, $2, $3)", [bookId, rating, content]);

    res.redirect(`/review-by-key?key=${olKey}`);
  } catch (err) {
    console.error(err);
    res.status(500).send("Server error while submitting review");
  }
});

app.get("/edit-review", async (req, res) => {
  const bookKey = req.query.key;

  if (!bookKey) return res.status(400).send("Missing key");
  const reviewRow = await db.query("SELECT rating, content FROM reviews JOIN books ON reviews.book_id = books.id WHERE books.openlibrary_key = $1", [bookKey]);
  const rating = reviewRow.rows[0].rating;
  const content = reviewRow.rows[0].content;

  res.render("review-form.ejs", {
    formTitle: "Edit Review",
    formAction: `/edit-review?key=${bookKey}`,
    rating,
    content,
    error: null
  });
});

app.post("/edit-review", async (req, res) => {
  const olKey = req.query.key;
  const {rating, content} = req.body;

  if(!olKey) return res.status(400).send("Missing Key");

  if(rating < 1 || rating > 5) {
    return res.render("review-form.ejs",{
      formTitle: "Write Review",
      formAction: `/write-review?key=${olKey}`,
      content,
      error: "Rating should be between 1 and 5"
    });
  }
  

  try {
    let result = await db.query("SELECT id FROM books WHERE openlibrary_key = $1", [olKey]);
    if (result.rows.length === 0){
      return res.status(404).send ("Book not found");
    }
    let bookId;
    bookId= result.rows[0].id;

     await db.query("UPDATE reviews SET rating =$1, content = $2 WHERE book_id = $3",[rating,content,bookId]);
     res.redirect(`/review-by-key?key=${olKey}`);
  } catch (err){
    console.error(err);
    res.status(500).send("Server error while submitting edited review");
  }
});

app.get("/delete-review", async (req, res) => {
  const bookKey = req.query.key;
   if (!bookKey) return res.status(400).send("Missing key");
  try{
   const result = await db.query("SELECT id FROM books WHERE books.openlibrary_key = $1",[bookKey]);
   if (result.rows.length === 0){
      return res.status(404).send ("Book not found");
    }
   let tobeBook = result.rows[0].id;

   await db.query("DELETE FROM reviews WHERE book_id = $1",[tobeBook]);
   await db.query("DELETE FROM books WHERE openlibrary_key = $1",[bookKey]);
   res.redirect("/"); 
  }catch (err){
    console.error("Error executing query", err.stack);
  }
});
app.listen(port, () => {
  console.log(`Server running on port ${port}`);
});
