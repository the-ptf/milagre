function hold(task, set) {
  set.add(task);
  task.then(
    () => set.delete(task),
    () => set.delete(task),
  );
  return task;
}
module.exports = { hold };
