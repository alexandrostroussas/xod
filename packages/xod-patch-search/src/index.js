import * as R from 'ramda';
import Fuse from 'fuse.js';
import { Maybe } from 'ramda-fantasy';
import { getBaseName } from 'xod-project';
import { foldMaybe } from 'xod-func-tools';

import createIndexData from './mapper';

const options = {
  shouldSort: true,
  tokenize: true,
  matchAllTokens: true,
  includeScore: true,
  threshold: 0.37,
  location: 0,
  distance: 1000,
  maxPatternLength: 32,
  minMatchCharLength: 2,
  keys: [
    {
      name: 'path',
      weight: 0.1,
    },
    {
      name: 'keywords',
      weight: 0.2,
    },
    {
      name: 'lib',
      weight: 0.05,
    },
    {
      name: 'description',
      weight: 0.3,
    },
    {
      name: 'fullDescription',
      weight: 0.5,
    },
  ],
};

const sortByScoreOrAlphabetically = R.sort((a, b) => {
  if (a.score < b.score) return -1;
  else if (a.score > b.score) return 1;
  else if (a.item.path < b.item.path) return -1;
  else if (a.item.path > b.item.path) return 1;

  return 0;
});

const calculateEntryRate = (str, token) => {
  // If basename fully equal to token
  if (str === token) return 0.1;

  const index = str.indexOf(token);
  // If str begins with token
  if (index === 0) return 0.2;
  // If part of str begins with token
  if (str[index - 1] === '-') return 0.3;
  // If str ends with token
  if (str.length === index + token.length) return 0.5;
  // If str doesn't contain token
  if (index === -1) return 3;
  // If str contains token
  return 2.5;
};

const calculatePenaltyForPath = R.curry((token, item) => {
  const path = item.item.path;
  const basename = getBaseName(path);
  const index = basename.indexOf(token);
  const k = calculateEntryRate(path, token);

  return index === -1 ? 0.25 : index / 100 * k;
});

const refineScore = R.curry((query, result) =>
  R.compose(
    sortByScoreOrAlphabetically,
    R.unless(
      () => query.trim().split(' ').length > 1, // TODO
      R.map(item => {
        const tokens = query.trim().split(' ');
        const token = tokens[0];

        const pathPenalty = calculatePenaltyForPath(token, item);
        const newScore = item.score + pathPenalty;
        return R.assoc('score', newScore, item);
      })
    )
  )(result)
);

const refineScoreForSpecializationNode = R.curry((query, result) =>
  R.compose(
    sortByScoreOrAlphabetically,
    R.map(item => {
      const tokens = query.trim().split(',');
      const tokensInItem = R.filter(R.contains(R.__, item.item.path), tokens);
      const tokensInItemCount = tokensInItem.length;

      const newScore =
        tokensInItemCount > 0 ? item.score / tokensInItemCount : Infinity;

      return R.assoc('score', newScore, item);
    })
  )(result)
);

const getAverageScore = resultList =>
  R.compose(
    R.divide(R.__, resultList.length),
    R.reduce(R.add, 0),
    R.pluck('score')
  )(resultList);

const reduceResults = rawResults => {
  // Cut results with "Infinity" score from results
  const results = R.reject(R.propEq('score', Infinity), rawResults);

  const averageScore = getAverageScore(results);
  const scoreToFilter = Math.min(averageScore * 2, 0.3);

  if (results.length <= 5) return results;

  const filtered = results.filter(r => r.score < scoreToFilter);
  if (filtered.length > 1) return filtered;

  return results;
};

const itemPathContainsOpeningBracket = R.pathSatisfies(R.contains('('), [
  'item',
  'path',
]);

const filterSpecializationNodes = R.curry((query, idx) =>
  R.ifElse(
    R.contains('('),
    R.compose(
      R.reject(R.complement(itemPathContainsOpeningBracket)),
      foldMaybe(idx, refineScoreForSpecializationNode(R.__, idx)),
      Maybe,
      R.nth(1),
      R.match(/\((.+)\){0,1}$/)
    ),
    () => R.reject(itemPathContainsOpeningBracket)(idx)
  )(query)
);

// :: String -> String
const takeQueryWithoutBrackets = R.compose(R.nth(0), R.split('('));

// :: [IndexData] -> SearchIndex
export const createIndex = data => {
  const idx = new Fuse(data, options);

  return {
    search: query =>
      R.compose(
        reduceResults,
        filterSpecializationNodes(query),
        refineScore(query),
        idx.search.bind(idx),
        takeQueryWithoutBrackets
      )(query),
  };
};
// :: [Patch] -> SearchIndex
export const createIndexFromPatches = R.compose(createIndex, createIndexData);

export { default as createIndexData } from './mapper';
