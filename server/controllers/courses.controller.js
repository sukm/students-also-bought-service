const Redis = require('ioredis');
const db = require('../../database/neo4j/index');
const log = require('../logger');

const redis = new Redis(process.env.REDIS_PORT, process.env.REDIS_HOST);
const session = db.session();

const getStudent = `
  MATCH (s:Student { id: { courseId } }) 
  RETURN s
`;

const getCourse = `
  MATCH (c:Course {id: { courseId }} 
  RETURN c;
`;

const getCoursesWithSameCategory = `
  MATCH (c: Course) - [: IN_CATEGORY] -> (category: Category { id: { categoryId } })
  RETURN c LIMIT 10;
`;

const getCourseCategory = `
  MATCH (c:Course { id: { courseId }}) - [:IN_CATEGORY] -> (category:Category)
  RETURN category;
`;

const queryMostEnrolledCourses = `
  MATCH(s: Student) - [:ENROLLED] -> (c: Course { id: { courseId } })
  WITH s
  MATCH(s) - [: ENROLLED] -> (c)
  WHERE NOT(c.id = { courseId })
  RETURN c, COUNT(*) AS cnt
  ORDER BY cnt
  DESC LIMIT 10
`;

const checkRated = `
  RETURN EXISTS( (s:Student { id: { courseId }) - [:RATED] -> (c:Course)
`

// Personalized recommendation based on Category 
const contentBasedFiltering = `
  MATCH (s:Student { id: { courseId }) - [:RATED] -> (c:Course)
  MATCH (c) - [:IN_CATEGORY] -> (category:Category) <- [:IN_CATEGORY] - (rec: Course)
  WHERE NOT EXISTS ( (s) - [:RATED] -> (rec) )
  WITH rec, [category.name, COUNT(*)] AS scores 
  RETURN rec.courseTitle AS recommendation,
  COLLECT (scores) AS scoreComponents,
  REDUCE (s=0,x in COLLECT(scores) | s+x[1]) AS score
  ORDER BY score DESC LIMIT 10;
`

// READ
async function getCourses(data, res) {
  const category = await session.run(getCourseCategory, data);

  const categoryData = {
    categoryId: parseInt(category.records[0]._fields[0].properties.id.low, 10),
    name: category.records[0]._fields[0].properties.name,
  };

  const cachedResponse = await redis.get(`category${categoryData.categoryId}`);
  if (cachedResponse) {
    // log.info(`${categoryData.categoryId}, category id, redis get success`);
    data.body = JSON.parse(cachedResponse);
    return res.status(200).send(data.body);
  }
  const result = await session.run(getCoursesWithSameCategory, categoryData);

  const courses = [];
  result.records.forEach((record) => {
    courses.push(record._fields[0].properties);
  });
  if (courses.length) {
    redis.set(`category${categoryData.categoryId}`, JSON.stringify(courses));

    return res.status(200).send(courses);
  }
  return res.status(400).json('unable to get courses');
}

async function getMostEnrolledCourses(req, res, next) {
  let result; 
  const courseData = {
    courseId: parseInt(req.courseId, 10),
  };
  const cachedResponse = await redis.get(req.courseId);

  if (cachedResponse) {
    // log.info(`${req.courseId}, courseId redis get success`);
    req.body = JSON.parse(cachedResponse);
    return res.status(200).send(req.body);
  }
  const hasRated = await session.run(checkRated, courseData);

  if (hasRated) {
    result = await session.run(contentBasedFiltering, courseData);
  } else {
    result =  await session.run(queryMostEnrolledCourses, courseData);
  }

  session.close();
  const courses = [];

  // If courses do not exist 
  if (!result.records.length) {
    return getCourses(courseData, res);
  }
  result.records.forEach((record) => {
    courses.push(record._fields[0].properties);
  });
  if (courses.length) {
    redis.set(courseData.courseId, JSON.stringify(courses));
    return res.status(200).send(courses);
  }
  return res.status(400).json('unable to get courses');
}

module.exports = { getMostEnrolledCourses };
