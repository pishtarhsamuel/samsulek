"""Forward recorders: long-running processes that write down what they observe, as they observe it.

Recorded data is only as good as its coverage, so recorders also write down when they
were NOT watching (gaps), and research must account for those gaps.
"""
