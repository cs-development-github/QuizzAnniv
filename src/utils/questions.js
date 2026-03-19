const path = require("path");

const questions = require(path.join(__dirname, "..", "..", "data", "questions.json"));

function loadQuestions() {
  return questions.map((question) => ({
    ...question,
    answers: [...question.answers],
  }));
}

function sanitizeQuestionForClient(question) {
  return {
    prompt: question.prompt,
    answers: question.answers,
  };
}

function getCorrectAnswerIndex(question) {
  return Number(question.correctAnswerIndex);
}

module.exports = {
  loadQuestions,
  sanitizeQuestionForClient,
  getCorrectAnswerIndex,
};
