printf 'PARENT_STARTED\n'
( printf 'CHILD_STARTED\n' ) &
wait
