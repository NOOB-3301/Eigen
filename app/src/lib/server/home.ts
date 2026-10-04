import { homePaths, type HomePaths } from "@eigen/engine/home";

/** Resolved per call so EIGEN_HOME changes (tests) are honoured; it is cheap. */
export const paths = (): HomePaths => homePaths();

/** Strip the home folder from messages bound for the browser. */
export const scrubPaths = (msg: string) => msg.replaceAll(paths().home, "~/.eigen");
